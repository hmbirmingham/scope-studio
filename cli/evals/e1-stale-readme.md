---
id: e1-stale-readme
use_case: code-feature
workspace: ~/vscode/stm32-peripherals
branch: eval/e1-stale-readme
difficulty: trivial
---

## Task

README.md and BUILD_LOG.md contradict each other. The README advertises
"I2C, SPI, ADC/DMA and FreeRTOS on the roadmap"; the BUILD_LOG says the repo
ends at UART and that those are not planned here. The BUILD_LOG is the newer
intent — a separate repository now holds the systolic array and 3D sensing.

Make the README agree with the BUILD_LOG. Say plainly where the work continued,
so a reader who arrives at the roadmap line is not misled about what this repo
is for.

## Gates

- builds-nothing: files_untouched 01-blinky 02-uart
- readme-changed: files_changed README.md
- no-cancelled-roadmap: must_not_match (?i)(i2c|spi|adc|freertos).{0,40}roadmap
- keeps-the-projects-table: must_match (?s)\| Folder \| Peripheral \| Status \|
- keeps-the-toolchain: must_match (?i)## Toolchain
- substantial: min_words 120
