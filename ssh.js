

const SPAWN = require("child_process").spawn;
const EXEC = require("child_process").exec;

// TODO: Combine with 'https://github.com/pinf-io/pio/blob/master/lib/ssh.js' and put into 'pinf.io' lib.

exports.for = function (API) {

    var exports = {};

    exports.runRemoteCommands = function (options, callback) {

        function runCommands () {
            return API.Q.denodeify(function (callback) {

                API.ASSERT.equal(typeof options, "object");
                API.ASSERT.equal(typeof options.targetUser, "string");
                API.ASSERT.equal(typeof options.targetHostname, "string");
                API.ASSERT.equal(Array.isArray(options.commands), true);
                API.ASSERT.equal(typeof options.keyPath, "string");
                API.ASSERT.equal(typeof options.workingDirectory, "string");

                console.log(("Calling commands '" + options.commands.join("; ") + "' (identity: " + options.targetUser + " / " + options.keyPath + ") on vm '" + options.targetHostname + "' at path '" + options.workingDirectory + "'").magenta);

                var args = [
                    '-o', 'ConnectTimeout=5',
                    '-o', 'ConnectionAttempts=1',
                    '-o', 'UserKnownHostsFile=/dev/null',
                    '-o', 'StrictHostKeyChecking=no',
                    '-o', 'UserKnownHostsFile=/dev/null',
                    '-o', 'IdentityFile=' + options.keyPath,
                    options.targetUser + '@' + options.targetHostname,
                    'cd ' + options.workingDirectory + '; bash -e -s'
                ];

                console.log(("Run: ssh " + args.join(" ")).magenta);

                var timeoutInterval = null;
                var proc = SPAWN("/usr/bin/ssh", args, {
            /*                          
                    env: self._settings.sshkey.addSshAskpassEnvVars({
                        PATH: process.env.PATH
                    })
            */
                    env: {
                        PATH: process.env.PATH
                    }
                });
                var stdout = [];
                proc.stdout.on('data', function (data) {
                    stdout.push(data.toString());
                    process.stdout.write(data);
                });
                var stderr = [];
                proc.stderr.on('data', function (data) {
                    stderr.push(data.toString());
                    process.stderr.write(data);
                });
                proc.on('close', function (code) {
                    if (timeoutInterval) {
                        clearTimeout(timeoutInterval);
                    }
                    if (code !== 0) {
                        if (code === 255) {
                            API.console.verbose("ERROR: " + stderr.join(""));
                            API.console.verbose("Waiting 5 seconds and trying again ...");
                            return API.Q.delay(5000).then(function() {
                                return runCommands();
                            }).then(function () {
                                return callback(null);
                            }, callback);
                        }
                        console.error("ERROR: Remote command exited with code '" + code + "'");
                        return callback(new Error("Remote command exited with code '" + code + "' and stderr: " + stderr.join("")));
                    }
                    return callback(null, {
                        code: code,
                        stdout: stdout.join(""),
                        stderr: stderr.join("")
                    });
                });
                proc.stdin.write(options.commands.join("\n"));
                proc.stdin.end();

                if (options.timeout) {
                    timeoutInterval = setTimeout(function () {
                        timeoutInterval = null;
                        API.console.verbose("Kill SSL connection process: " + proc.pid);
                        EXEC("kill -9 " + proc.pid);
                    }, options.timeout * 1000);
                }
            })();
        }

        return runCommands();
        //API.Q.timeout(runCommands(), 120 * 1000).fail(function(err) {
        //    console.error("ERROR: Timeout waiting for SSH to become available.");
        //    throw err;
        //});
    }

    return exports;
}
