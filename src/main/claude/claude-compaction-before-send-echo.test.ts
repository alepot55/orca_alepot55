// Claude compacts before it echoes a send, so the compaction status arrives while the send is
// started and unechoed: the adapter's host-side stamp must reach the activity line, or it reads
// "Working…" for the whole compaction. Frame order from the CLI 2.1.295 capture on issue #26840.

import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../shared/agent-session-wire'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  adapterFor,
  claudeFrame,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'

const SEND: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Investigate activity' }]
}

describe('compaction before the send is echoed', () => {
  it('shows the compacting line against the started send, then drops it once the turn opens', async () => {
    const activities: (AgentSessionTurnActivity | null)[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {},
      setActivity: (activity) => activities.push(activity)
    }
    const claude = fakeClaude({ replayUuid: null })
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    const connection = claude.connections[0]!

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-A',
      body: SEND,
      requestedAt: 1_700_000_000_000,
      fence: 7
    })
    expect(outcome).toMatchObject({ state: 'admitted' })
    const sentUuid = connection.sent.at(-1)?.uuid
    expect(typeof sentUuid).toBe('string')

    claudeFrame(connection, { type: 'command_lifecycle', command_uuid: sentUuid, state: 'started' })
    claudeFrame(connection, { type: 'system', subtype: 'status', status: 'compacting' })
    expect(activities.at(-1)).toEqual({
      turnId: 'client-A',
      text: 'Compacting the conversation',
      precedesTurn: true
    })

    claudeFrame(connection, {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'success'
    })
    expect(activities.at(-1)).toBeNull()

    claudeFrame(connection, { type: 'system', subtype: 'status', status: 'compacting' })
    claudeFrame(connection, {
      type: 'user',
      uuid: sentUuid,
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: [{ type: 'text', text: 'Investigate activity' }] }
    })
    expect(activities.at(-1)).toBeNull()

    await adapter.closeAll()
  })
})
