# 共有fixtureの取得元

このディレクトリのJSONと`LICENSE`は、`Naohiro2g/minecraft-remote-tooling`の
`packages/protocol/test/fixtures/`から、commit `36ebe9e63e4f0afcf949eae998832f68209b8119`のbytesをそのままcopyしたものです。
`LICENSE`（MIT）はこのディレクトリのfileに適用されます。

| file | bytes | SHA-256 |
| --- | ---: | --- |
| `client-bootstrap-framing-v23.2.1.json` | 15131 | `be063b519b5d653a4bb4ec3da6f67e5d481a28dcf5913961c848b2b909d4b26d` |
| `client-bootstrap-hello-v23.2.1.json` | 20913 | `78297f05eb4352b0dabffab3242e933c1e68cb192bbb6d242019c7956c809d57` |
| `client-bootstrap-pairing-v23.2.1.json` | 35577 | `5864c23ef3f31af6134d36770cab80b569b708b35fd3fdbed69fb6db195e3aeb` |
| `client-bootstrap-blocks-v23.2.1.json` | 45945 | `664babdf3131a74e4aaf6d9e5dfb5e4cfc6e197df0a0d48142688820f1be813d` |
| `client-bootstrap-errors-v23.2.1.json` | 9179 | `c458d3ffbae846cfb33c032eba14d8f0005c6a1fbe871290b53fcfec8ec41aaa` |
| `client-bootstrap-close-v23.2.1.json` | 14884 | `a030cc72aa0e4f41575cb15610b1e06e941d3eab07157ce47f0eafe744475154` |
| `client-bootstrap-v1.schema.json` | 10916 | `8c3e4ff6e7b5b0cf438d358578096579dafab699a40df9cd56de7b9513837413` |
| `block-value-v22.json` | 3217 | `e8e108d59c40751d67a432543d75cb4bf9146ef9781721012085c80545b854f3` |
| `LICENSE` | 1070 | `aa329a0bafc839b95124306141db13a381de45818bf629e983c44ea55ab5a7fb` |

`test/client-bootstrap-fixture.test.mjs`が、この表のbytesとSHA-256を毎回確かめます。取得元を変えるときは、
knowledgeの指示に従ってcommitを固定し直し、この表とtestの値を同じ変更で直します。
