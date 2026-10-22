# minecraft-remote-typescript

`minecraft-remote-typescript`は、現行Minecraft Remote Protocolの一般用途TypeScript Client Libraryです。Scratch Clientとは別の成果物です。

## McRemote SSOT

McRemote 固有の設計判断の正本は GitHub 上の `Naohiro2g/mc-remote-knowledge` です。

McRemote 固有文脈に依存する作業に入る前に、agent はその SSOT リポジトリの関連文書を
必ず読んでください。対象には architecture / protocol / deployment / contributor workflow /
learning design、および McRemote 固有の判断理由に依存する挙動変更が含まれます。

最初に、knowledge リポのリモート `main` から最新の dev agent runtime protocol だけを取得して
指示として読んでください。取得元ファイル全体を会話へ出力してはいけません。

```bash
protocol_source="$(mktemp)"
knowledge_commit="$(gh api repos/Naohiro2g/mc-remote-knowledge/commits/main -q .sha)"
gh api "repos/Naohiro2g/mc-remote-knowledge/contents/00-hub/dev-repo-protocol_ja.md?ref=$knowledge_commit" \
  -q .content | base64 -d > "$protocol_source"
if [ "$(grep -Fxc '<!-- BEGIN: DEV-AGENT-RUNTIME -->' "$protocol_source")" -ne 1 ] || \
   [ "$(grep -Fxc '<!-- END: DEV-AGENT-RUNTIME -->' "$protocol_source")" -ne 1 ]; then
  echo "dev agent runtime marker missing or duplicated" >&2
  exit 1
fi
printf 'knowledge commit: %s\n' "$knowledge_commit"
awk '/^<!-- BEGIN: DEV-AGENT-RUNTIME -->$/{reading=1;next} \
     /^<!-- END: DEV-AGENT-RUNTIME -->$/{reading=0} \
     reading' "$protocol_source"
```

SSOT リポジトリへアクセスできない場合は、作業を止め、その旨を明示してください。この
リポジトリ単体、assistant memory、過去会話、ローカル推論から欠けた文脈を補完してはいけません。
SSOT にアクセスできるまで、McRemote 固有文脈に依存する設計判断や実装を進めないでください。

このファイルは SSOT を複製しません。複製はドリフトを生みます。

- このリポの関連スポーク: 17-typescript-client/, 10-protocol/

## このリポ固有の指示

- Node.jsの選択と切り替えはmiseを正準とする。
- `@mc-remote/protocol`（minecraft-remote-tooling）に依存しない。protocolの型と定数はこのrepositoryで持ち、共有fixtureは固定したcommitで読む。
- `package.json`は`private: true`を保つ。publish、registryの名前、release workflowは、knowledge SSOTで決まるまで足さない。
- wire formatに触れる前に`10-protocol`、このrepositoryの作業では`17-typescript-client`を読む。
- token、private endpoint、credential、operator-localの設定をcommitしない。
- 横断する発見はlocalの`NOTES_ja.md`へ一時捕捉し、session／sliceの終わりにknowledge hubへ上げる。
- 自分が編集したpathだけを明示stageする。
