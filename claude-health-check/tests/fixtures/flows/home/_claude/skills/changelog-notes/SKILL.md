---
name: changelog-notes
description: Writes the changelog entry for a version from the merged changes. Use when the user asks for release notes or a changelog entry.
when_to_use: |
  1. This numbered line sits in the front matter.
  2. So does this one.
  3. And this one.
  4. And this one.
  5. And this one.
  6. And this one.
  7. Seven lines here, more than the procedure below has.
---

# Changelog notes

Write the entry in the past tense and keep each line under eighty characters.

1. A short list that comes before the procedure.
2. It has two items only.

## Procedure

1. Find the tag of the **last version** with `git describe --tags`.
2. List the changes merged since that tag.

   ```sh
   1. this line is inside a code block
   2. so is this one
   - If the list is empty, stop.
   git log --oneline v1.2.0..HEAD
   ```

3. Group the changes by type:
   - features
   - fixes
   - internal changes
4. Write one line per change. Start each line with a verb.
5. Show the entry to the user and wait for an answer. Should the user ask for changes, rewrite the entry and show it again.
6. Save the entry at the top of `CHANGELOG.md`.
