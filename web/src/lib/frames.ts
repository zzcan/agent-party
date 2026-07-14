import type { PresenceEntry, ServerFrame } from "@agentparty-mini/shared";

export type Msg = Extract<ServerFrame, { type: "msg" }>;

export interface ChannelState {
  self: string;
  seqHigh: number;
  mode: string;
  guard: number;
  messages: Msg[];
  presence: PresenceEntry[];
}

export function initialState(): ChannelState {
  return { self: "", seqHigh: 0, mode: "normal", guard: 0, messages: [], presence: [] };
}

export function reduce(state: ChannelState, frame: ServerFrame): ChannelState {
  switch (frame.type) {
    case "hello":
      return { ...state, self: frame.self, seqHigh: frame.seq_high, mode: frame.mode, guard: frame.guard, presence: frame.presence };
    case "msg": {
      if (state.messages.some((m) => m.seq === frame.seq)) return state;
      return { ...state, messages: [...state.messages, frame] };
    }
    case "presence": {
      const rest = state.presence.filter((p) => p.name !== frame.entry.name);
      return { ...state, presence: [...rest, frame.entry] };
    }
    default:
      return state;
  }
}
