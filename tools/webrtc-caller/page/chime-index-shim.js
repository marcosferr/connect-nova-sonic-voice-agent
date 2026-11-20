// Surgical replacement for amazon-chime-sdk-js's package index. The only
// in-tree consumer is build/task/PromoteToPrimaryMeetingTask.js (require("..")),
// which uses just these two exports. Importing the real index would drag the
// Chime messaging client + AWS SDK + node builtins into the browser bundle.
module.exports = {
  MeetingSessionStatus:
    require('amazon-chime-sdk-js/build/meetingsession/MeetingSessionStatus').default,
  MeetingSessionStatusCode:
    require('amazon-chime-sdk-js/build/meetingsession/MeetingSessionStatusCode').default,
};
