import type {
  IpcErrorDetails,
  IpcResponse,
  TypedIpcResponse
} from "./messages";

type Extends<Left, Right> = [Left] extends [Right] ? true : false;
type ExpectFalse<Value extends false> = Value;

interface EnvelopeFixture {
  id: "fixture";
  type: "health.check";
  version: 2;
  serverInstanceId: "server";
  requestSequence: 1;
}

type ErrorFixture = IpcErrorDetails & {
  code: "IPC_TIMEOUT";
  message: "timeout";
  recoverable: true;
  action: "passThrough";
};

export type IpcResponseRejectsSuccessWithError = ExpectFalse<Extends<
  EnvelopeFixture & { ok: true; payload: {}; error: ErrorFixture },
  IpcResponse
>>;

export type IpcResponseRejectsErrorWithPayload = ExpectFalse<Extends<
  EnvelopeFixture & { ok: false; payload: {}; error: ErrorFixture },
  IpcResponse
>>;

export type NonSessionResponseRejectsEpoch = ExpectFalse<Extends<
  EnvelopeFixture & {
    ok: true;
    payload: { status: "ok"; engineReady: true; warnings: [] };
    sessionEpoch: 1;
  },
  TypedIpcResponse<"health.check">
>>;

export type SessionResponseRequiresEpoch = ExpectFalse<Extends<
  Omit<TypedIpcResponse<"session.processKeyStroke">, "sessionEpoch">,
  TypedIpcResponse<"session.processKeyStroke">
>>;
