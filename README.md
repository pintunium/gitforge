# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/pintunium/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/pintunium/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, built with the Node standard library only — no dependencies. It implements the full surface end to end: git smart HTTP (protocol v0 and v2, ls-refs, shallow fetch and deepen, per-ref push reports with fast-forward enforcement), the REST v3 API (repositories, contents, branches, commits, labels, issues, comments and pull requests with squash merges), a GraphQL v4 endpoint (queries, mutations, introspection, connections and batched operations) and an MCP server (modern `server/discover` plus the legacy initialize handshake, with tools for repositories, issues and pull requests). Objects are stored and returned byte-for-byte verbatim, so every hash recomputes exactly as a real git client expects.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> npm start
```

The program binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, serves until the env reports the trial is done, and then exits 0. Node 22 or newer is required (the entry runs with `--experimental-strip-types`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=pintunium&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
