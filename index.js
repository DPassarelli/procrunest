const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const debug = require('debug')('procmonrest')
const terminate = require('tree-kill')

/**
 * A collection of private values for each instance of this class.
 * @type {WeakMap}
 */
const _ = new WeakMap()

/**
 * [INVALID_LOG_PATH description]
 * @type {String}
 */
const INVALID_LOG_PATH = 'If specified, the "saveLogTo" option must refer to a valid location that this proces has write-access to.'

class Procmonrest {
  /**
   * Options:
   *   command  {String?}  The command that the child process will execute.
   *                       Defaults to `npm start`.
   *
   *   waitFor  {RegExp}   A pattern of characters that will be looked for in
   *                       the child process's stdout stream, which will
   *                       indicate that it is ready for testing.
   *
   * @constructor
   */
  constructor (options) {
    options = options || {}

    try {
      options.waitFor.test('this should fail if missing or not a regexp')
    } catch {
      throw new Error('The constructor for Procmonrest takes an options object with a required value for "waitFor".')
    }

    const privateData = {
      cmd: options.command || 'npm start',
      pattern: options.waitFor,
      ready: false,
      ref: options.reference || null
    }

    if (options.saveLogTo) {
      try {
        privateData.log = {
          path: path.normalize(options.saveLogTo)
        }

        debug('log path set to "%s"', privateData.log.path)
      } catch (err) {
        debug('could not normalize log path "%s"', options.saveLogTo)
        throw new Error(INVALID_LOG_PATH)
      }
    }

    _.set(this, privateData)
  }

  /**
   * Spawns the child process. Resolves once the process outputs a line matching
   * the pattern specified by "waitFor" in the constructor.
   *
   * @return {Promise}   Resolves to undefined.
   */
  async start () {
    /**
     * The directory that the child process will be executed in.
     * @type {String}
     */
    const workingDirectory = process.cwd()

    const privateData = _.get(this)

    if (privateData.log) {
      await new Promise((resolve, reject) => {
        debug('START: creating write stream for log file "%s"', privateData.log.path)

        privateData.log.stream = fs.createWriteStream(privateData.log.path)

        privateData.log.stream.once('ready', resolve)

        privateData.log.stream.once('error', () => {
          reject(new Error(INVALID_LOG_PATH))
        })
      })

      privateData.log.stream.write('************************************\n')
      privateData.log.stream.write('*      STDOUT/STDERR LOG FILE      *\n')
      privateData.log.stream.write('************************************\n')
      privateData.log.stream.write(`Command:     ${privateData.cmd}\n`)

      if (privateData.ref) {
        privateData.log.stream.write(`Reference:   ${privateData.ref}\n`)
      }

      privateData.log.stream.write('\n') // whitespace for readability
    }

    debug('START: attempting to start cmd "%s" with cwd "%s"', privateData.cmd, workingDirectory)
    debug('START: waiting for output to match %o', privateData.pattern)

    privateData.subProcess = childProcess.spawn(
      privateData.cmd,
      {
        cwd: workingDirectory,
        shell: true,
        stdio: 'pipe'
      }
    )

    return new Promise((resolve, reject) => {
      privateData.subProcess.stdout.on('data', (data) => {
        const lines = data
          .toString()
          .split(/\r?\n/)
          .filter(line => line.length > 0)

        lines.forEach((line) => {
          if (privateData.log) {
            privateData.log.stream.write(`STDOUT: ${line}\n`)
          }

          if (!privateData.ready && privateData.pattern.test(line)) {
            debug('START: process is ready!')
            privateData.ready = true
            resolve()
          }
        })
      })

      privateData.subProcess.stderr.on('data', (data) => {
        if (privateData.log) {
          data
            .toString()
            .split(/\r?\n/)
            .filter(line => line.length > 0)
            .forEach(line => privateData.log.stream.write(`STDERR: ${line}\n`))
        }
      })

      privateData.subProcess.once('exit', (code, signal) => {
        if (!privateData.ready) {
          const err = new Error('The process exited before indicating that it was ready for testing')
          err.exitCode = code

          debug('START:', err.message.toLowerCase())
          reject(err)
        }

        if (privateData.log && privateData.log.stream) {
          // code may be 0 (which is valid and should be reported), so do *not* evaluate that first
          privateData.log.stream.write(`EXIT CODE: ${signal || code}\n`)
          privateData.log.stream.end()
        }

        privateData.ready = false
        privateData.subProcess = null
      })
    })
  }

  /**
   * A flag indicating whether the child process is currently running.
   *
   * @return {Boolean}
   */
  get isRunning () {
    return _.get(this).ready
  }

  /**
   * Sends a signal to terminate the child process. Resolves when complete.
   *
   * @return {Promise}
   */
  async stop () {
    const privateData = _.get(this)

    if (privateData && privateData.subProcess) {
      debug('STOP: attempting to terminate process with id %d...', privateData.subProcess.pid)

      try {
        await terminate(privateData.subProcess.pid)
        debug('STOP: ...done!')
      } catch (err) {
        const patternForMissingProcessId = /the process "\d+" not found/i

        if (patternForMissingProcessId.test(err.message)) {
          debug('STOP: ...process was not found')
          throw new Error('There is nothing to stop. Please call start() first.')
        } else {
          debug('STOP: ...an error occurred ->', err.message)
          throw err
        }
      } finally {
        privateData.ready = false
        privateData.subProcess = null
      }
    } else {
      debug('STOP: process has not started')
      throw new Error('There is nothing to stop. Please call start() first.')
    }
  }
}

module.exports = Procmonrest
