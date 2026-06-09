# Keyboard Prediction Training Report

Generated: 2026-06-09T12:24:08.767Z

## Inputs

| Dataset | Rows read | Rows used | Rows skipped |
| ------- | --------- | --------- | ------------ |
| d1      | 1000000   | 998433    | 1567         |
| d2      | 99998     | 64999     | 34999        |
| d3      | 249685    | 82209     | 167476       |
| d4      | 250000    | 23878     | 226122       |
| d7      | 1000000   | 938478    | 61522        |
| d8      | 100000    | 0         | 0            |

## Outputs

- Context predictions: 80000
- Prefix predictions: 60000
- Unique context pairs observed: 1400001
- Unique prefix pairs observed: 1000001
- Blind rows excluded: 73801
- Model checksum: aaa3d9f2ae4debf0a18d5e0df6d1285cde2c8fdd2291d823b1cd24c4390c0ba5

## Privacy

- Raw public rows stay in quarantine/generated corpus files and are not bundled as examples.
- Runtime model emits aggregate context/prefix rows only.
- D8 blind rows are excluded before training to avoid leakage.
