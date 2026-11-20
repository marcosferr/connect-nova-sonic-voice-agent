"""session_data — copies trusted contact facts into the Q in Connect session.

Invoked by the contact flow (NOT an MCP tool) right after the Q in Connect
session is created. Every key/value in the Invoke-Lambda block's
`LambdaInvocationAttributes` becomes a `{{$.Custom.<key>}}` variable in the
orchestration prompt, e.g.

    customer_phone = $.CustomerEndpoint.Address   (caller ID from the carrier)

Why: the voice model must never be the source of identity. The caller ID
comes from the telephone network, so `validar_cliente` is called with a
number the model did not hear, guess or invent.

Fails soft: on any error it returns `status=error` and the flow continues;
the prompt then tells the agent to ask for the phone number.
"""
import logging
import os
import re

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_connect = boto3.client("connect")
_qconnect = boto3.client("qconnect")

_NAMESPACE = "Custom"  # the only namespace prompts can read ({{$.Custom.<key>}})
_SESSION_ARN = re.compile(
    r"^arn:aws[a-z-]*:wisdom:[^:]+:\d+:session/(?P<assistant>[^/]+)/(?P<session>[^/]+)$"
)


def lambda_handler(event, _context):
    details = event.get("Details", {})
    contact = details.get("ContactData", {})
    params = details.get("Parameters") or {}
    if not params:
        return {"status": "success", "keysSet": ""}

    try:
        described = _connect.describe_contact(
            InstanceId=contact["InstanceARN"], ContactId=contact["ContactId"]
        )
        session_arn = (described["Contact"].get("WisdomInfo") or {}).get("SessionArn", "")
        match = _SESSION_ARN.match(session_arn)
        if not match:
            raise RuntimeError("contact has no Q in Connect session (run CreateWisdomSession first)")

        data = [{"key": k, "value": {"stringValue": str(v)}} for k, v in params.items() if v]
        _qconnect.update_session_data(
            assistantId=match["assistant"],
            sessionId=match["session"],
            namespace=_NAMESPACE,
            data=data,
        )
    except (ClientError, KeyError, RuntimeError) as exc:
        logger.exception("UpdateSessionData failed")
        return {"status": "error", "errorCode": type(exc).__name__}

    keys = ",".join(d["key"] for d in data)
    logger.info("session data set: %s", keys)
    return {"status": "success", "keysSet": keys}
