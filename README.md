> [!NOTE]
> このリポジトリの公開ドキュメントは日本語を正本とします。[言語方針](https://github.com/Naohiro2g/mc-remote-knowledge/blob/main/LANGUAGE_POLICY.md)を参照してください。

# Minecraft Remote for TypeScript

現行 Minecraft Remote Protocol の一般用途 TypeScript Client Library です。Scratch Client とは別の成果物です。
現在は開発基盤を用意した段階で、接続・hello・認証などの protocol 実装と公開 API はまだありません。

## 開発を始める

[mise](https://mise.jdx.dev/) を用意し、このリポジトリで次を実行してください。

```bash
mise trust
mise install
mise exec -- npm ci
mise exec -- npm run check
```

Node.js の版は `mise.toml` に固定しています。package manager は Node.js 付属の npm、
test runner は Node.js 標準の `node:test` です。追加の package manager や test runner を導入せず、
lockfile による依存の再現と ESM の読み込み確認ができます。

| コマンド（`mise exec --` に続ける） | 内容 |
| --- | --- |
| `npm run build` | TypeScript を ESM と型定義へ出力 |
| `npm run lint` | ESLint による静的検査 |
| `npm test` | build 後、root module の unit test を実行 |
| `npm run check` | lint と test を実行 |

GitHub Actions でも同じ Node.js の版と `npm ci`、`npm run check` を使います。
package 名 `@mc-remote/client` は仮置きで、`private: true` としています。

## 設計の正本

- [knowledge の入口](https://github.com/Naohiro2g/mc-remote-knowledge/blob/main/00-hub/INDEX_ja.md)
- [TypeScript Client の範囲と実装開始の前提](https://github.com/Naohiro2g/mc-remote-knowledge/blob/main/17-typescript-client/README_ja.md)
- [Protocol contract](https://github.com/Naohiro2g/mc-remote-knowledge/tree/main/10-protocol)

agent の作業手順は [AGENTS.md](AGENTS.md) を参照してください。
