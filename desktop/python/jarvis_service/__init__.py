"""JARVIS local service: speech, allowlisted Windows actions, online AI adapter.

Runs on 127.0.0.1 only, authenticated with a per-session token, and executes
only fixed handlers declared in :mod:`jarvis_service.registry`.
"""

PROTOCOL_VERSION = 1
SERVICE_NAME = "jarvis-local"

__all__ = ["PROTOCOL_VERSION", "SERVICE_NAME"]
