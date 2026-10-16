<!-- SPDX-FileCopyrightText: 2026 HanYang06 -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/HanYang06/Lurnia/security/advisories/new)
(the *Security* tab → *Report a vulnerability*). If that is unavailable, contact
the maintainer directly rather than filing publicly.

Please include:

- what the problem is and where it lives (file, function, or behaviour);
- how to reproduce it, ideally with the smallest example that shows it;
- what an attacker could do with it;
- any suggested fix, if you have one.

You will get an acknowledgement, and we will agree on a disclosure timeline with
you before anything is published.

## Supported versions

Lurnia is pre-1.0 and does not commit to a 1.0. Fixes land in the **current
`0.x` line**; older `0.x` releases are not maintained in parallel. See
[`docs/design/versioning.md`](docs/design/versioning.md).

## What this project treats as a vulnerability

The nine invariants in [`docs/design/invariants.md`](docs/design/invariants.md)
are the project's definition of "must never break". Two matter most here:

- **I9 — the APP takes no unauthorized outward action.** It must not open a
  browser, start an outward-facing service, listen on a port, or reach the
  network on its own. A change that makes any of those happen is a security
  issue, not a feature request. (The Python core running as a Tauri-managed
  sidecar is internal implementation, not an outward action — see
  [`docs/design/packaging.md`](docs/design/packaging.md).)
- **I2 — permission decisions never collapse to a boolean.** A path where a
  `DENY` or `UNCERTAIN` is silently treated as allowed is a security issue.

Also in scope:

- the config layer's path-containment checks (values must stay inside the
  configured home);
- the DDL/resource loader reading something outside the package;
- anything that lets untrusted input reach a filesystem write, a SQL statement,
  or code execution.

## What is *not* a vulnerability

- **The absence of source obfuscation.** The sidecar ships as bytecode and can be
  decompiled; this is documented and accepted — see
  [`docs/design/packaging.md`](docs/design/packaging.md) §八. "I decompiled it"
  is not a report.
- **The local database being readable by the local user.** Lurnia is local-first
  and user-owned; the data on disk belongs to whoever runs the APP. Encryption at
  rest is not currently claimed.
- Findings that require the attacker to already have code execution or write
  access to the user's own data directory.

## Automated scanning

This repository runs CodeQL on every push and pull request, plus weekly, and
dependency review on every pull request. See
[`.github/workflows/`](.github/workflows/).
