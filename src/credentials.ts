// session tokenの置き場所（DECISIONS 2026-08-30-03）。保存のbackendはapplicationが差し込む。

/** tokenを保存する範囲。application、credentialの種類、transport、接続先ごとに分け、暗黙に共有しない。 */
export interface CredentialKey {
  readonly application: string;
  readonly credentialType: 'session';
  readonly transport: 'tcp';
  readonly target: string;
}

/** 差し込むcredential store。同期でも非同期でも実装できる。 */
export interface CredentialStore {
  load(key: CredentialKey): string | undefined | Promise<string | undefined>;
  save(key: CredentialKey, token: string): void | Promise<void>;
  delete(key: CredentialKey): void | Promise<void>;
}

/** 何も保存しない。接続のたびにpairingが要る。 */
export function noCredentialStore(): CredentialStore {
  return {
    load: () => undefined,
    save: () => {},
    delete: () => {},
  };
}

/** processの中だけで保持する。processが終われば消える。 */
export function memoryCredentialStore(): CredentialStore {
  const tokens = new Map<string, string>();
  const id = (key: CredentialKey) => JSON.stringify([key.application, key.credentialType, key.transport, key.target]);
  return {
    load: (key) => tokens.get(id(key)),
    save: (key, token) => {
      tokens.set(id(key), token);
    },
    delete: (key) => {
      tokens.delete(id(key));
    },
  };
}
