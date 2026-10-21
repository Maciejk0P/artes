# outer-app

Sample memory of the field fixture; none of this is a real instruction.

## How the service behaves

- The export covers all customers except in the test region.
- A matcher is instantiated only if its modality is configured.
- Pravidlo sa použije na všetky súbory okrem generovaných.

## Rules

- Never commit to the main branch, unless the change is a release tag.
- Nikdy nemaž testy, ani dočasne, ešte pred revíziou.

## Commit messages

- Always write the subject line of a commit message in the imperative mood.
- Never end the subject line of a commit message with a full stop.

## What wins when rules collide

1. Correctness before speed.
2. Readability before cleverness.
3. Small changes before large ones.
4. Facts before opinions.
5. Tests before refactoring.

## Before a release

1. Run the full test suite.
2. `npm run build`
3. Then update the changelog.
4. Tag the commit.
