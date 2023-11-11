/**
 * Implmentation of a log reader that reads data from log files written by the collector
 * service and emits the same to the socket clients connected to their respective child processes.
 */

/* eslint-disable security/detect-non-literal-fs-filename */
import * as fs from 'fs'
import * as path from 'path'
import * as EventEmitter from 'events'
import * as readline from 'readline'

import { config } from '../Config'
class DataLogReader extends EventEmitter {
  activeLogFileName: string
  logCounter = 1

  constructor(
    public logDir: string,
    public dataName: string
  ) {
    super()
    this.activeLogFileName = `active-${dataName}-log.txt`
  }

  async init(): Promise<void> {
    const activeLogFilePath = path.join(this.logDir, this.activeLogFileName)
    if (await this.fileExists(activeLogFilePath)) {
      // Read the active log file to get the current log counter
      const activeLog = fs.readFileSync(activeLogFilePath, {
        encoding: 'utf8',
      })
      const activeLogNumber = parseInt(activeLog.replace(`${this.dataName}-log`, '').replace('.txt', ''))
      console.log(`Active log file found: ${activeLogFilePath} with number ${activeLogNumber}`)
      if (activeLogNumber) {
        this.logCounter = activeLogNumber
      }

      // Read the log file and skip the entries that have already been recorded
      const logFile = path.join(this.logDir, `${this.dataName}-log${this.logCounter}.txt`)
      if (!(await this.fileExists(logFile))) {
        throw new Error(`Log file ${logFile} does not exist`)
      }
      const stat = fs.statSync(logFile)
      let startEntries = 0
      let foundEndNumberofEntriesLine = false
      const stream = fs.createReadStream(logFile, {
        encoding: 'utf8',
        start: 0,
        end: stat.size,
      })
      const rl = readline.createInterface({
        input: stream,
      })
      rl.on('line', (data) => {
        /* prettier-ignore */ if (config.VERBOSE) console.log(data)
        try {
          // if the data contains a line with "End: Number of entries: ", then we know that the file has been rotated.
          if (data.includes('End: Number of entries: ')) {
            foundEndNumberofEntriesLine = true
          } else {
            // commented below line b/c it causes lint error(parse is never used)
            // const parse = JSON.parse(data)
            startEntries++
          }
          /* prettier-ignore */ if (config.VERBOSE) console.log(this.dataName, 'startEntries', startEntries)
        } catch (e) {
          /* prettier-ignore */ if (config.VERBOSE) console.log('data is not complete!')
        }
      })
      stream.on('end', () => {
        console.log('Finished reading the file.')
        if (!foundEndNumberofEntriesLine) {
          console.log(
            `Starting at ${this.dataName}-log${this.logCounter}.txt with size ${stat.size} and ${startEntries} entries`
          )
          this.readLogFile(stat.size, startEntries)
        }
        rl.close()
        stream.close()
      })
    }

    // listen to the active log file
    fs.watch(activeLogFilePath, async (event: string, filename: string) => {
      if (filename) {
        let activeLog = ''
        do {
          activeLog = fs.readFileSync(activeLogFilePath, {
            encoding: 'utf8',
          })
        } while (activeLog === '')
        const activeLogNumber = parseInt(activeLog.replace(`${this.dataName}-log`, '').replace('.txt', ''))
        if (isNaN(activeLogNumber)) return
        if (activeLogNumber === this.logCounter) return
        if (activeLogNumber) {
          this.logCounter = activeLogNumber
        }
        console.info(`Switching to new File ${this.dataName}-log${this.logCounter}.txt`)
        this.readLogFile()
      }
    })
  }

  async readLogFile(startSize = 0, startEntries = 0): Promise<void> {
    const logFile = path.join(this.logDir, `${this.dataName}-log${this.logCounter}.txt`)
    if (!(await this.fileExists(logFile))) {
      throw new Error(`Log file ${logFile} does not exist`)
    }
    let currentSize = startSize
    let totalNumberOfEntries = startEntries

    const fileStreamer = setInterval(() => {
      fs.stat(logFile, (err, stats) => {
        if (err) {
          console.error(err)
          return
        }
        if (stats.size > currentSize) {
          const stream = fs.createReadStream(logFile, {
            encoding: 'utf8',
            start: currentSize,
            end: stats.size,
          })
          currentSize = stats.size

          const rl = readline.createInterface({
            input: stream,
          })
          // read the stream line-by-line
          rl.on('line', (data) => {
            try {
              // if the data contains a line with "End: Number of entries: ", then we know that the file has been rotated.
              if (data.includes('End: Number of entries: ')) {
                const entryCount = parseInt(data.split(':').slice(-1)[0].trim())
                if (isNaN(entryCount)) {
                  console.error(
                    'Error: File has been rotated but the last line does not contain the total number of entries'
                  )
                }
                if (totalNumberOfEntries !== entryCount)
                  console.log(
                    'Total number of entries does not not match with the entry Count.',
                    totalNumberOfEntries,
                    entryCount
                  )
                this.emit(`${this.dataName}-end`, totalNumberOfEntries, entryCount)
                // End the interval
                clearInterval(fileStreamer)
              } else {
                const parse = JSON.parse(data)
                totalNumberOfEntries += 1
                /* prettier-ignore */ if (config.VERBOSE) console.log(`${this.dataName}-data`, data)
                this.emit(`${this.dataName}-data`, parse)
              }
            } catch (e) {
              /* prettier-ignore */ if (config.VERBOSE) console.log('data is not complete!')
            }
          })
          rl.on('error', (err) => {
            console.error('Error occurred in File Streamer', logFile, err)
          })
          stream.on('end', () => {
            // End of line
            rl.close()
            stream.close()
          })
        }
      })
    }, config.FILE_STREAM_INTERVAL_MS) // Check for new data
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK)
      return true
    } catch (err) {
      return false
    }
  }
}

export default DataLogReader
