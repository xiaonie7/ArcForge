"""WeCom's adapter for the authenticated, provider-neutral binding contract.

This module never calls WeCom APIs or creates a replacement conversation.
The desktop archives history only after the durable close is acknowledged.
"""

from __future__ import annotations

import asyncio

from .commands import SessionKey
from .protocol import ChannelBindingResponse


def binding_handler(state_store, sequencer):
    async def handle(request):
        try:
            if request.installation_id != state_store.installation_id:
                raise ValueError("installation mismatch")
            key = SessionKey.from_scope_key(request.scope_key)
            if request.action == "query":
                return ChannelBindingResponse(**await state_store.run_async(state_store.binding_operation, request))

            async def close():
                async with sequencer.lock_for(key):
                    return await state_store.run_async(state_store.binding_operation, request)

            result = await asyncio.wait_for(close(), timeout=5)
            return ChannelBindingResponse(**result)
        except asyncio.TimeoutError:
            return ChannelBindingResponse(operation_id=request.operation_id, status="busy")
        except (ValueError, TypeError):
            return ChannelBindingResponse(operation_id=request.operation_id, status="conflict", message="Invalid or mismatched lifecycle request")
    return handle
