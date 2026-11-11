// Protocol contract（knowledge 10-protocol）のうち、このclientが投影する型と定数。

/** このclientがhelloで申告するprotocol。 */
export const PROTOCOL_VERSION = '23.2.1';

/** McRemoteのTCPの通常のport。 */
export const DEFAULT_PORT = 25575;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** block stateの値。JSONのscalarだけを許す（wire 7.1）。 */
export type BlockStateValue = boolean | number | string;

/** setの入力。stateは部分指定でよく、省いたpropertyはMinecraftの既定値になる。 */
export interface BlockSpec {
  block_id: string;
  state: Record<string, BlockStateValue>;
}

/** getの出力。block_idは完全修飾、stateはfull state。 */
export interface BlockValue {
  readonly block_id: string;
  readonly state: Readonly<Record<string, BlockStateValue>>;
}

export type Position = readonly [x: number, y: number, z: number];

export interface ClientIdentity {
  name: string;
  version: string;
  locale: string;
}

/** helloの`build`。省くとserverの既定（`minecraft:overworld`、原点(200,0,200)）になる。 */
export interface BuildContext {
  dimension: string;
  origin: Position;
}

/** helloの成功result。fieldの名前はwireのまま。 */
export interface HelloResult {
  readonly protocol: string;
  readonly mc_version: string;
  readonly supported_mc_versions: readonly string[];
  readonly catalogHash: string | null;
  readonly world_constants: { readonly y_sea: number | null; readonly [key: string]: unknown };
  readonly session: string;
  readonly player: string;
  readonly dimension: string;
  readonly origin: Position;
  readonly permissions: { readonly online: boolean; readonly offline: boolean; readonly buildRange: number };
  readonly server: string;
  readonly [key: string]: unknown;
}

interface ProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseProtocolVersion(text: string): ProtocolVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * serverのprotocolが、clientの申告を満たすか（versioning 8.2）。
 * majorの一致、serverのminorが同じか上。patchは見ない。版として読めない値は満たさない。
 */
export function isCompatibleProtocol(clientRequires: string, server: string): boolean {
  const client = parseProtocolVersion(clientRequires);
  if (!client) throw new RangeError(`protocolの版として読めない: ${clientRequires}`);
  const plugin = parseProtocolVersion(server);
  return plugin !== undefined && plugin.major === client.major && plugin.minor >= client.minor;
}
