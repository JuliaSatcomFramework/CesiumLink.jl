# Issue tracker: local markdown

Issues and specs for this repo live as markdown files under `.scratch/`, which is gitignored.

The repository has a GitHub remote, so this is a choice rather than a limit: a ticket set is drafted,
reordered and thrown away many times over one effort, and none of that is worth a round trip. Move a
ticket to GitHub Issues when somebody outside the effort has to see it.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from `01` — never a single combined tickets file
- Triage state is a `Status:` line near the top of each issue file
- Comments append to the bottom of the file under a `## Comments` heading
