// Bootstrap examples for the task centroids (ARCHITECTURE.md §3.2, weakness 3).
// Replace with real labeled queries once query_metrics.inferred_task_type and
// user_confirmed_useful accumulate; rebuild with `npm run centroids`.
export const TASK_EXAMPLES = {
  codebase: [
    'what does quantify_colonies return',
    'where is the session middleware configured',
    'how does the migration runner track applied migrations',
    'which function parses the incoming request body',
    'what arguments does the ingest endpoint accept',
    'where do we validate the privacy flag on nodes',
    'show me how the retry loop handles a timeout',
  ],
  firmware: [
    'why does the UART ISR drop bytes at 115200 baud',
    'where is the watchdog timer configured in main.c',
    'how do I set up the I2C driver for the IMU',
    'the bootloader jumps to the wrong address after flashing',
    'which GPIO pins are mapped to the motor driver',
    'add a DMA transfer for the ADC sampling loop',
    'the RTOS task for the sensor read is starving',
  ],
  hardware: [
    'what is the max input voltage on the buck converter',
    'which decoupling capacitors are on the 3.3V rail in the schematic',
    'check the BOM for the part number of the MOSFET',
    'why did we pick the STM32 over the ESP32 for the sensor board',
    'what footprint does the USB-C connector use in KiCad',
    'the netlist shows an unconnected pin on U3',
    'what is the datasheet-rated current for the LDO',
  ],
  data_pipeline: [
    'why does the ETL job fail on null timestamps',
    'where is the pandas dataframe joined with the metadata table',
    'how are the raw sensor CSVs cleaned before training',
    'the batch job is slow on the groupby step',
    'which script normalizes the colony count images',
    'what schema does the parquet output use',
    'add a validation step for duplicate rows in the ingest script',
  ],
  research: [
    'what anomaly detection threshold did we settle on',
    'which paper motivated the watershed segmentation approach',
    'summarize the related work on colony counting',
    'what did we conclude about the false positive rate in the thesis draft',
    'what citation supports the choice of Otsu thresholding',
    'why did we choose watershed over contour detection',
    'what were the results in the latest experiment writeup',
  ],
  cross_project: [
    'which repos use Flask',
    'what projects depend on the shared logging library',
    'where else is the OpenCV pipeline reused',
    'list every project that talks to the Postgres instance',
    'which codebases still target Python 3.8',
    'what other projects use this PCB footprint library',
    'find all repos with a Dockerfile',
  ],
};
