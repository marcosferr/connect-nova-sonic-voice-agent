// Browser side of the synthetic caller. Bundled to bundle.js by esbuild.
// Joins the Amazon Chime SDK meeting returned by StartWebRTCContact, feeds
// pre-synthesized audio clips into the call, and reports VAD state for the
// bot's audio so the Node/Python side can pace the dialogue.

// Import the concrete modules instead of the package index: the index eagerly
// pulls the Chime messaging client (+ AWS SDK + node builtins) which cannot be
// bundled for the browser without fragile shims.
import ConsoleLogger from 'amazon-chime-sdk-js/build/logger/ConsoleLogger';
import LogLevel from 'amazon-chime-sdk-js/build/logger/LogLevel';
import DefaultDeviceController from 'amazon-chime-sdk-js/build/devicecontroller/DefaultDeviceController';
import DefaultMeetingSession from 'amazon-chime-sdk-js/build/meetingsession/DefaultMeetingSession';
import MeetingSessionConfiguration from 'amazon-chime-sdk-js/build/meetingsession/MeetingSessionConfiguration';

const emit = (obj) => window.emitEvent(JSON.stringify(obj));

let session = null;
let audioCtx = null;
let micDest = null;

window.callerJoin = async (connectionData) => {
  try {
    const logger = new ConsoleLogger('caller', LogLevel.WARN);
    const deviceController = new DefaultDeviceController(logger);
    const cfg = new MeetingSessionConfiguration(
      { Meeting: connectionData.Meeting },
      { Attendee: connectionData.Attendee },
    );
    session = new DefaultMeetingSession(cfg, logger, deviceController);

    audioCtx = new AudioContext({ sampleRate: 48000 });
    micDest = audioCtx.createMediaStreamDestination();
    // constant silent source keeps the outbound track live between clips
    const silent = audioCtx.createConstantSource();
    silent.offset.value = 0;
    silent.connect(micDest);
    silent.start();

    await session.audioVideo.startAudioInput(micDest.stream);
    const audioEl = document.getElementById('remote-audio');
    session.audioVideo.bindAudioElement(audioEl);

    session.audioVideo.addObserver({
      audioVideoDidStart: () => emit({ event: 'joined' }),
      audioVideoDidStop: (status) => {
        let code = null;
        try { code = status.statusCode(); } catch (e) { /* ignore */ }
        emit({ event: 'stopped', code });
      },
    });
    session.audioVideo.start();
    await audioCtx.resume();
    setupVAD(audioEl);
  } catch (e) {
    emit({ event: 'error', message: String((e && e.stack) || e) });
  }
};

function setupVAD(audioEl) {
  const stream = audioEl.srcObject;
  if (!stream || stream.getAudioTracks().length === 0) {
    setTimeout(() => setupVAD(audioEl), 200);
    return;
  }
  const src = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let state = 'silence';
  emit({ event: 'vadready' });
  setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const newState = rms > 0.008 ? 'speech' : 'silence';
    if (newState !== state) {
      state = newState;
      emit({ event: 'vad', state, rms: Number(rms.toFixed(4)) });
    }
  }, 50);
}

window.callerPlay = async (url, name) => {
  try {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(arr);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const gain = audioCtx.createGain();
    gain.gain.value = 1.6; // Polly neural is quiet for telephony ASR
    src.connect(gain);
    gain.connect(micDest);
    src.onended = () => emit({ event: 'playdone', name });
    // small lead-in so short clips aren't clipped by encoder ramp-up
    src.start(audioCtx.currentTime + 0.15);
    emit({ event: 'playstart', name, seconds: Number(buf.duration.toFixed(2)) });
  } catch (e) {
    emit({ event: 'error', message: 'play ' + name + ': ' + String(e) });
  }
};

window.callerStop = () => {
  try { if (session) session.audioVideo.stop(); } catch (e) { /* ignore */ }
  emit({ event: 'leftcall' });
};
