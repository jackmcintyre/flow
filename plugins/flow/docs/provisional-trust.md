# Provisional trust (cold-start auto-merge)

`plugin.provisional_trust` is a config flag that lets the auto-merge gate
merge a pull request **with no human in the loop** while the team's agreement
history is still being built up. It exists to solve a cold-start problem: the
normal auto-merge gate needs a window of past reviewer/dev verdicts to judge
whether the team is trustworthy enough to merge automatically. On a brand-new
repo that window is empty, so without this flag *every* PR would pause and wait
for a human — even the safest ones. Provisional trust bootstraps the loop by
letting the lowest-risk changes flow through while that history accrues.

## What it does

When `provisional_trust` is `true`, the auto-merge gate will auto-merge a
**`low`-risk** PR even when the agreement metric is still `null` — that is,
while the agreement window has not yet filled with enough resolved verdict
pairs to compute a meaningful ratio. This spans the whole ramp from zero
history up to a full window, not just the very first PR. The intent is
deliberate: low-risk merges have to flow during the ramp so that agreement
history can build up and the normal threshold gate can eventually take over.

It **defaults to `false`**. With the flag off (the default), a `low`-risk PR
that lacks enough agreement history pauses and waits for a human, just like
every other PR.

## The safety constraint — low-risk PRs only

This is the part that matters most: **provisional trust ONLY relaxes the gate
for `low`-risk PRs.** It changes exactly one outcome — a `low`-risk PR whose
agreement window is still filling. Nothing else.

`medium`-risk, `high`-risk, and untiered PRs **always pause for a human**,
regardless of whether this flag is on or off. The flag cannot and does not
auto-merge them. Concretely:

| Risk tier of the PR        | With `provisional_trust: true` | With `provisional_trust: false` |
|----------------------------|--------------------------------|---------------------------------|
| `low`, history still filling | auto-merges                  | pauses for a human              |
| `medium`                   | pauses for a human             | pauses for a human              |
| `high`                     | pauses for a human             | pauses for a human              |
| untiered (no tier resolved) | pauses for a human            | pauses for a human              |

So the worst the flag can do is auto-merge a change that the risk classifier
has already determined is `low`-risk — typically docs-only or comment-only
changes. (See [`risk-tiering.md`](./risk-tiering.md) for how a PR's risk tier
is decided.) Anything with real blast radius still waits for you.

## How to enable / disable

The flag lives under the `plugin:` block in your repo's `.flow/config.yaml`.

To **enable** it:

```yaml
plugin:
  provisional_trust: true
```

To **disable** it, set it back to `false` (or remove the line entirely — the
default is `false`):

```yaml
plugin:
  provisional_trust: false
```

The flag is **operator-controlled and has no automatic expiry.** It will stay
on until you turn it off yourself — there is no built-in timer or counter that
disables it once enough history exists.

## When to take the training wheels off

The design intent is that provisional trust is temporary. The auto-merge gate
keeps a rolling window of the team's last 50 **resolved** verdict pairs (a
reviewer verdict matched with the PR's eventual merge outcome). Once that window
fills, the gate computes a real agreement ratio and switches to the normal
threshold gate on its own — at which point `provisional_trust` has no further
effect, because it only ever applied while that window was empty.

**Important — the window does not fill automatically yet.** A verdict pair only
becomes "resolved" when the PR's merge outcome is recorded as telemetry (via the
`recordPrCloseAction` tool). Today that recording is **not wired into the
auto-merge path**: when the gate auto-merges a PR it does not record a
merge-outcome event. So in practice the agreement window stays empty, the ratio
stays `null`, and **provisional trust never supersedes itself.** Until
merge-outcome recording is wired up (tracked as a follow-up), the off-ramp is
**manual** — judge it yourself rather than waiting for the window:

- A reasonable rule of thumb: keep it **on** for an unattended proof run where
  you want low-risk changes to flow hands-off, and turn it **off** for normal
  operation once you've watched a batch of the loop's low-risk merges land
  cleanly and you're comfortable a human should see the next ones.
- Turning it off is the config edit above (`provisional_trust: false`). With it
  off, every low-risk PR pauses for a human until real agreement history exists.

You can inspect the current history at any time in the telemetry under
`.flow/telemetry/*.jsonl`: count `reviewer.verdict.merge_action` events whose
`merge_action` is `merged` or `closed-unmerged` — those are the resolved pairs
that count toward the window of 50. (An empty count means the window has not
started filling, which today is the expected state.)
