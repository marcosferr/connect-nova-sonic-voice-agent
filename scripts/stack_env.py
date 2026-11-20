"""Resolve the deployed environment from CloudFormation outputs — no hard-coded IDs.

Every dev script imports this instead of embedding instance/assistant/flow IDs.

Environment (all optional):
  AWS_PROFILE    AWS CLI profile (default: the SDK default chain)
  AWS_REGION     default us-east-1
  PROJECT_NAME   default pizza-voice   (must match the CDK app's PROJECT_NAME)
  ENV_NAME       default dev

Usage:
  from stack_env import load_env
  env = load_env()
  env.instance_id, env.assistant_id, env.contact_flow_id, env.ai_agent_id,
  env.table("orders"), env.session()  # boto3.Session

CLI:  python scripts/stack_env.py   → prints the resolved values as JSON
"""
import json
import os
from dataclasses import dataclass, field

import boto3


@dataclass
class StackEnv:
    project: str
    env_name: str
    region: str
    profile: str | None
    outputs: dict = field(default_factory=dict)

    def session(self) -> boto3.Session:
        return boto3.Session(profile_name=self.profile, region_name=self.region)

    def _out(self, key: str) -> str:
        for k, v in self.outputs.items():
            if k.startswith(key):
                return v
        raise KeyError(f"stack output '{key}*' not found — is the ConversationalAI stack deployed?")

    @property
    def instance_id(self) -> str:
        return self._out("ConnectInstanceId")

    @property
    def assistant_id(self) -> str:
        return self._out("AssistantId")

    @property
    def contact_flow_id(self) -> str:
        return self._out("ContactFlowId")

    @property
    def ai_agent_id(self) -> str:
        return self._out("OrchestratorAgentId")

    @property
    def gateway_url(self) -> str:
        return self._out("McpGatewayGatewayUrl")

    def table(self, name: str) -> str:
        """DynamoDB table name, e.g. table('orders') → pizza-voice-orders-dev."""
        return f"{self.project}-{name}-{self.env_name}"

    def as_dict(self) -> dict:
        d = {"project": self.project, "env": self.env_name, "region": self.region}
        for attr in ("instance_id", "assistant_id", "contact_flow_id", "ai_agent_id", "gateway_url"):
            try:
                d[attr] = getattr(self, attr)
            except KeyError:
                d[attr] = None
        d["orders_table"] = self.table("orders")
        return d


def load_env() -> StackEnv:
    project = os.environ.get("PROJECT_NAME", "pizza-voice")
    env_name = os.environ.get("ENV_NAME", "dev")
    region = os.environ.get("AWS_REGION", "us-east-1")
    profile = os.environ.get("AWS_PROFILE") or None
    env = StackEnv(project, env_name, region, profile)
    cfn = env.session().client("cloudformation")
    stack = f"{project}-{env_name}-conversational-ai"
    outs = cfn.describe_stacks(StackName=stack)["Stacks"][0].get("Outputs", [])
    env.outputs = {o["OutputKey"]: o["OutputValue"] for o in outs}
    return env


if __name__ == "__main__":
    print(json.dumps(load_env().as_dict(), indent=2))
