# 共有fixtureの取得元

このディレクトリのJSONと`LICENSE`は、`Naohiro2g/minecraft-remote-tooling`の
`packages/protocol/test/fixtures/`から、commit `0d120e5ea1942178983fd0496827df7e7976f4e8`のbytesをそのままcopyしたものです。
`LICENSE`（MIT）はこのディレクトリのfileに適用されます。

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `client-bootstrap-framing-v23.2.1.json` | 15131 | `be063b519b5d653a4bb4ec3da6f67e5d481a28dcf5913961c848b2b909d4b26d` |
| `client-bootstrap-hello-v23.2.1.json` | 26046 | `caf24ad5382e411ba54172b05d6020fc59fc429dc0251ff28db3908b4189784e` |
| `client-bootstrap-pairing-v23.2.1.json` | 35577 | `5864c23ef3f31af6134d36770cab80b569b708b35fd3fdbed69fb6db195e3aeb` |
| `client-bootstrap-blocks-v23.2.1.json` | 45945 | `664babdf3131a74e4aaf6d9e5dfb5e4cfc6e197df0a0d48142688820f1be813d` |
| `client-bootstrap-errors-v23.2.1.json` | 9179 | `c458d3ffbae846cfb33c032eba14d8f0005c6a1fbe871290b53fcfec8ec41aaa` |
| `client-bootstrap-close-v23.2.1.json` | 20879 | `2abb6f48942e1dc7bc42014ba016c3d08a6632c59445c048b008a4c411ea1e30` |
| `client-bootstrap-operations-v23.2.1.json` | 66029 | `3ccc97e4c80dbf51a0de9c27ef4e974fffa1ee7ec1708aeb7a49ffe14b8366a4` |
| `client-bootstrap-v1.schema.json` | 11465 | `4dcce4bc0a63c5e2536411e5276a85ceb8fa20bf5fef64ce2f7a2b8deb069774` |
| `client-bootstrap-v2.schema.json` | 19423 | `f533de2755974147dd3d7c8f61fa3b190fc5031188a67d648b876ee33f979a77` |
| `block-value-v22.json` | 3217 | `e8e108d59c40751d67a432543d75cb4bf9146ef9781721012085c80545b854f3` |
| `LICENSE` | 1070 | `aa329a0bafc839b95124306141db13a381de45818bf629e983c44ea55ab5a7fb` |

v1（`mcremote.client-bootstrap.v1`）の6 fileは`test/client-bootstrap-fixture.test.mjs`、
v2（`mcremote.client-bootstrap.v2`）の`client-bootstrap-operations-v23.2.1.json`は
`test/client-bootstrap-operations.test.mjs`が読みます。前者が、この表のbytesとSHA-256を毎回確かめます。
取得元を変えるときは、knowledgeの指示に従ってcommitを固定し直し、この表とtestの値を同じ変更で直します。
