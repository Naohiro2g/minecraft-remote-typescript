export {
  type Clock,
  type ConnectOptions,
  MinecraftRemote,
  type PairingChallenge,
  type PairingHandler,
  connect,
} from './client.js';
export {
  type CredentialKey,
  type CredentialStore,
  memoryCredentialStore,
  noCredentialStore,
} from './credentials.js';
export {
  ConnectionError,
  McRemoteError,
  PairingExpiredError,
  ProtocolMismatchError,
  RemoteError,
  type RemoteErrorObject,
} from './errors.js';
export {
  type BlockSpec,
  type BlockStateValue,
  type BlockValue,
  type BuildContext,
  type ClientIdentity,
  DEFAULT_PORT,
  type HelloResult,
  type JsonValue,
  PROTOCOL_VERSION,
  type Position,
  isCompatibleProtocol,
} from './protocol.js';
