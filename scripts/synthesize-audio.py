#!/usr/bin/env python3
"""Synthesize the caller's audio clips for scripts/call-test.py with Amazon Polly.

Reads tests/calls/audio/manifest.json ({key: text} or {key: {"text", "voice"}})
and writes tests/calls/audio/<key>.mp3. Existing files are skipped unless --force.
Deterministic clips are the point: every regression run plays the same audio.
The default caller voice (Pedro, es-US, neural) is deliberately different from
the bot's voice (Lupe) so transcripts and recordings are easy to tell apart.

Usage: python scripts/synthesize-audio.py [--force] [--only key1,key2]
Env:   AWS_PROFILE, AWS_REGION (see scripts/stack_env.py)
"""
import argparse
import json
import os
from pathlib import Path

import boto3

AUDIO_DIR = Path(__file__).resolve().parent.parent / "tests" / "calls" / "audio"
DEFAULT_VOICE = "Pedro"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-synthesize existing clips")
    ap.add_argument("--only", help="comma-separated manifest keys")
    args = ap.parse_args()

    manifest = json.loads((AUDIO_DIR / "manifest.json").read_text(encoding="utf-8"))
    manifest.pop("_comment", None)
    if args.only:
        keep = {k.strip() for k in args.only.split(",")}
        manifest = {k: v for k, v in manifest.items() if k in keep}

    polly = boto3.Session(profile_name=os.environ.get("AWS_PROFILE") or None,
                          region_name=os.environ.get("AWS_REGION", "us-east-1")).client("polly")
    done = skipped = 0
    for key, spec in manifest.items():
        out = AUDIO_DIR / f"{key}.mp3"
        if out.exists() and not args.force:
            skipped += 1
            continue
        text = spec if isinstance(spec, str) else spec["text"]
        voice = DEFAULT_VOICE if isinstance(spec, str) else spec.get("voice", DEFAULT_VOICE)
        kw = dict(Text=text, OutputFormat="mp3", VoiceId=voice, Engine="neural")
        if text.lstrip().startswith("<speak>"):
            kw["TextType"] = "ssml"
        out.write_bytes(polly.synthesize_speech(**kw)["AudioStream"].read())
        print(f"synthesized {out.name} ({voice}): {text!r}")
        done += 1
    print(f"done: {done} synthesized, {skipped} already present")


if __name__ == "__main__":
    main()
