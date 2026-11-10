# T-1115 implementation plan

Implement the supplied [brief](brief.md) in the existing isolated worktree.
Keep the default 180-second deadline and 5-second polling interval. Use only
offline Node tests and existing dependencies; leave gateway behavior and Pod
specifications unchanged.

1. Add regression tests for prepare status/error reporting, immediate failure,
   safe diagnostics, missing key names and single-argument process detection.
   Execute the embedded prepare script with fake HTTP, and observe failures.
2. Extend the existing check helper with `retry`, retain only validated diagnostic
   fields, and return a single status/code line from the prepare probe. Mark
   configuration and node mismatches permanent; preserve bounded retries.
3. Update takeover wording and document loopback port-forward access and the
   process-title limitation. Test the public gateway's existing route behavior.
4. Run the required tests and relevant offline checks, review the diff, and write
   a task report with Node version, test counts, changed files and output tails.

Review edge cases: all three permanent HTTP statuses, refused/reset connections,
request timeout, malformed probe output, unsafe diagnostic fields, absent Secret,
and configuration errors that must not poll.
