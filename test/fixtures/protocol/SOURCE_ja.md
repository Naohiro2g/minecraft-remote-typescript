# 共有fixtureの取得元

このディレクトリのJSONと`LICENSE`は、`Naohiro2g/minecraft-remote-tooling`の
`packages/protocol/test/fixtures/`から、commit `335c604f859d6dfad04f0434bfa4eb6445761430`のbytesをそのままcopyしたものです。
`LICENSE`（MIT）はこのディレクトリのfileに適用されます。

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `client-bootstrap-framing-v23.2.1.json` | 15131 | `be063b519b5d653a4bb4ec3da6f67e5d481a28dcf5913961c848b2b909d4b26d` |
| `client-bootstrap-hello-v23.2.1.json` | 26046 | `caf24ad5382e411ba54172b05d6020fc59fc429dc0251ff28db3908b4189784e` |
| `client-bootstrap-pairing-v23.2.1.json` | 45943 | `19230b310c7482adc740095d5604110937ebaa7803a0fed4c294083a9e63a460` |
| `client-bootstrap-blocks-v23.2.1.json` | 45945 | `664babdf3131a74e4aaf6d9e5dfb5e4cfc6e197df0a0d48142688820f1be813d` |
| `client-bootstrap-errors-v23.2.1.json` | 9179 | `c458d3ffbae846cfb33c032eba14d8f0005c6a1fbe871290b53fcfec8ec41aaa` |
| `client-bootstrap-close-v23.2.1.json` | 20879 | `2abb6f48942e1dc7bc42014ba016c3d08a6632c59445c048b008a4c411ea1e30` |
| `client-bootstrap-operations-v23.2.1.json` | 66335 | `8309f5847ad69aa2d82fcbcb1726918c3a69ba875e04e8f38678352b06b7f7a1` |
| `client-bootstrap-v1.schema.json` | 11521 | `970dd68999edc14a4dcc2b67ab2f712e830b7841b2ec4548fee66af117fd281b` |
| `client-bootstrap-v2.schema.json` | 19468 | `8ae1c7313d01fa0fa24f4f2079ba453129dc16b678342df6f7ef66b9255d1381` |
| `block-value-v22.json` | 3217 | `e8e108d59c40751d67a432543d75cb4bf9146ef9781721012085c80545b854f3` |
| `LICENSE` | 1070 | `aa329a0bafc839b95124306141db13a381de45818bf629e983c44ea55ab5a7fb` |

v1（`mcremote.client-bootstrap.v1`）の6 fileは`test/client-bootstrap-fixture.test.mjs`、
v2（`mcremote.client-bootstrap.v2`）の`client-bootstrap-operations-v23.2.1.json`は
`test/client-bootstrap-operations.test.mjs`が読みます。前者が、この表のbytesとSHA-256を毎回確かめます。
取得元を変えるときは、knowledgeの指示に従ってcommitを固定し直し、この表とtestの値を同じ変更で直します。
