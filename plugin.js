
const NET = require("net");
const DO = require("do-wrapper");

// @see https://developers.digitalocean.com/
// @see https://github.com/enzy/digitalocean-api

exports.for = function (API) {

	const SSH = require("./ssh").for(API);

	var exports = {};

	function makeAPI (resolvedConfig) {

		var api = new DO(resolvedConfig.credentials.token, 250);
		var _api = {};
		for (var name in api) {
			if (typeof api[name] === "function") {
				(function inject(name) {
					_api[name] = function() {
						var args = Array.prototype.slice.call(arguments, 0);
						return API.Q.nbind(api[name], api).apply(api, args).then(function (data) {
							if (!data) {
								throw new Error("No data for call '" + name + "'");
							}
							if (data.id === "unauthorized") {
								throw new Error("Error: " + JSON.stringify(data, null, 4));
							}
							return data;
						});
					}
				})(name);
			}
		}

		var exports = {};

		exports.getByName = function (name) {
			return _api.dropletsGetAll().then(function(droplets) {
				if (!droplets) {
					throw new Error("Error listing droplet! Likely due to Digital Ocean API being down.");
				}
				droplets = droplets.droplets.filter(function(droplet) {
					return (droplet.name === name);
				});
				if (droplets.length > 1) {
					throw new Error("Found more than 1 dropplet with name '" + name + "'");
				}
				if (droplets.length === 0) {
					return null;
				}
				var droplet = droplets.shift();
				function formatInfo(droplet) {
					var info = {
						_raw: droplet,
						ip: "",
						ipPrivate: ""
					};
					droplet.networks.v4.forEach(function (network) {
						if (network.type === "public") {
							info.ip = network.ip_address;
						} else
						// TODO: Verify that the type is in fact called `private`.
						if (network.type === "private") {
							info.ipPrivate = network.ip_address;
						}
					});
					return info;
				}
				if (droplet.status === "active") {
					return formatInfo(droplet);
				}
				function waitUntilReady(dropletId) {
					// TODO: Ensure we can never get into an infinite loop here. i.e. Add timeout.
					var deferred = API.Q.defer();
					function check() {
						return _api.dropletsGetDropletById(dropletId).then(function(droplet) {
							droplet = droplet.droplet;
							API.console.verbose("Waiting for vm to boot ...");
							if (droplet.status === "active") {
								return deferred.resolve(formatInfo(droplet));
							}
							setTimeout(check, 10 * 1000);
						}).fail(deferred.reject);
					}
					check();
					return deferred.promise;
				}
				return waitUntilReady(droplet.id);
			});
		}

		exports.ensureKey = function () {
			var keyName = resolvedConfig.dropplet.keyId;
			return _api.keysGetAll().then(function(keys) {
				keys = keys.ssh_keys.filter(function(key) {
					return (key.name === keyName);
				});
				if (keys.length === 0) {
					var publicKey = API.FS.readFileSync(resolvedConfig.dropplet.keyPubPath, "utf8");
					//publicKey = publicKey.match(/^(\S+\s+\S+)(\s+\S+)?\n?$/)[1];
					API.console.verbose(("Uploading SSH key '" + keyName + "' to Digital Ocean: " + publicKey).magenta);
					return _api.keysAddNew(keyName, publicKey).then(function(data) {
						return data.ssh_key.fingerprint;
					});
				}
				console.log("Verified that SSH key is on Digital Ocean.");
				return keys.shift().fingerprint;
			});
		}

		exports.removeKey = function (keyFingerprint) {
			API.console.verbose(("Removing SSH key '" + keyFingerprint + "' from Digital Ocean.").magenta);
			return _api.keysDestroyKey(keyFingerprint);
		}

		exports.create = function (vm) {

			function prepareParameters () {
				return _api.sizesGetAll().then(function(sizes) {

					API.console.debug("Sizes", sizes);

					return _api.imagesGetAll().then(function(images) {

						API.console.debug("Images", images);

						return _api.regionsGetAll().then(function(regions) {

							API.console.debug("Regions", regions);

							API.console.debug("Available images:");
							var foundImages = images.images.filter(function(image) {
								API.console.debug("  " + image.distribution + " - " + image.name + " (" + image.id + ")");
								if (image.distribution !== resolvedConfig.dropplet.distribution) return false;
								if (!new RegExp(resolvedConfig.dropplet.imageName).exec(image.name)) return false;
								return true;
							});
							if (foundImages.length === 0) {
								console.error("images", images);
								console.error("resolvedConfig.dropplet", resolvedConfig.dropplet);
								throw new Error("No image found!");
							}
							if (foundImages.length > 1) {
								API.console.verbose("WARN: Found more than 1 image:", foundImages);
							}
							API.console.verbose("Chosen image: " + JSON.stringify(foundImages[0]));

 							return exports.ensureKey().then(function(keyFingerprint) {

								var parameters = {
									name: resolvedConfig.dropplet.name,
									imageId: foundImages[0].id,
									optionals: {
										ssh_keys: [
											keyFingerprint
										],
										private_networking: false,
										backups: false,
										ipv6: false
									}
								};

								parameters.regionId = regions.regions.filter(function(region) {
									if (region.slug == resolvedConfig.dropplet.region) return true;
									return false;
								});
								if (parameters.length === 0) {
									console.log("regions", regions);
									throw new Error("Could not find region '" + resolvedConfig.dropplet.region + "' for slug value in regions above!");
								}
								parameters.regionId = parameters.regionId.shift().slug;


								parameters.sizeId = sizes.sizes.filter(function(size) {
									if (size.slug == resolvedConfig.dropplet.size) return true;
									return false;
								});
								if (parameters.sizeId.length === 0) {
									console.log("sizes", sizes);
									throw new Error("Could not find size '" + resolvedConfig.dropplet.size + "' for slug value in sizes above!");
								}
								parameters.sizeId = parameters.sizeId.shift();
								if (parameters.sizeId.regions.indexOf(parameters.regionId) === -1) {
									throw new Error("Size '" + resolvedConfig.dropplet.size + "' is not supported by region '" + resolvedConfig.dropplet.region + "'!");
								}
								parameters.sizeId = parameters.sizeId.slug;

								return [parameters, keyFingerprint];
							});
						});
					});
				});
			}

			return prepareParameters().then(function (info) {
				var parameters = info[0];
				API.FS.outputFileSync(API.PATH.join(API.getTargetPath(), "keyFingerprint"), info[1]);

				API.console.verbose(("Creating new Digital Ocean droplet with name: " + name + " and info " + JSON.stringify(parameters, null, 4) + " using token '" + resolvedConfig.credentials.tokenName + "'").magenta);

				return _api.dropletsCreateNewDroplet(
					parameters.name,
					parameters.regionId,
					parameters.sizeId,
					parameters.imageId,
					parameters.optionals
				).then(function(droplet) {
					if (!droplet) {
						throw new Error("Error creating droplet! Likely due to Digital Ocean API being down.");
					}
					function waitUntilReady(dropletId, actionId) {
						// TODO: Ensure we can never get into an infinite loop here. i.e. Add timeout.
						var deferred = API.Q.defer();
						function check() {
							_api.dropletActionGetStatus(dropletId, actionId).then(function (action) {
								console.log("Waiting for vm to boot ...");
								if (action.action.status === "completed") {
									return deferred.resolve();
								}
								setTimeout(check, 10 * 1000);
							}).fail(deferred.reject);
						}
						check();
						return deferred.promise;
					}
					if (droplet.id === "unprocessable_entity") {
						throw new Error("Error creating dropplet: " + JSON.stringify(droplet));
					}
					if (droplet.id === "forbidden") {
						throw new Error("Error creating dropplet: " + droplet.message);
					}
					return waitUntilReady(droplet.droplet.id, droplet.links.actions[0].id);
				});
			});
		}

		exports.ensure = function () {
			return exports.getByName(resolvedConfig.dropplet.name).then(function(vmInfo) {
				if (vmInfo) {
					resolvedConfig.vm = vmInfo;
					return;
				}

				return exports.create(resolvedConfig.dropplet).then(function() {
					return exports.getByName(resolvedConfig.dropplet.name).then(function(vmInfo) {
						resolvedConfig.vm = vmInfo;
						return vmInfo;
					});
				});
			});
		}

		return exports;
	}

	exports.resolve = function (resolver, config, previousResolvedConfig) {

		return resolver({}).then(function (resolvedConfig) {

			API.ASSERT.equal(typeof resolvedConfig.credentials.token, "string");
			API.ASSERT.equal(typeof resolvedConfig.credentials.tokenName, "string");

			API.ASSERT.equal(typeof resolvedConfig.dropplet, "object");
			API.ASSERT.equal(typeof resolvedConfig.dropplet.name, "string");
			API.ASSERT.equal(typeof resolvedConfig.dropplet.keyId, "string");
			API.ASSERT.equal(typeof resolvedConfig.dropplet.keyPath, "string");
			API.ASSERT.equal(typeof resolvedConfig.dropplet.keyPubPath, "string");

			resolvedConfig.dropplet.sshUser = resolvedConfig.dropplet.sshUser || "root";
			resolvedConfig.dropplet.size = resolvedConfig.dropplet.size || "1gb";
			resolvedConfig.dropplet.region = resolvedConfig.dropplet.region || "sfo1";
			resolvedConfig.dropplet.distribution = resolvedConfig.dropplet.distribution || "Ubuntu";
			resolvedConfig.dropplet.imageName = resolvedConfig.dropplet.imageName || "Docker.+on 14";


			resolvedConfig.status = "unknown";

			var api = makeAPI(resolvedConfig);

			var keyFingerprintPath = API.PATH.join(API.getTargetPath(), "keyFingerprint");
			var keyFingerprintExists = API.FS.existsSync(keyFingerprintPath);

		    function ensureSSH () {

		    	function isSshAvailable () {
			    	var ip = resolvedConfig.vm.ip;
			    	API.console.verbose("Ping '" + ip + ":22'");
			        var deferred = API.Q.defer();
			        var timeout = setTimeout(function() {
			            console.error("Timeout! Could not connect to: tcp://" + ip + ":22");
			            return deferred.resolve(false);
			        }, 1000);
			        var client = NET.connect({
			            host: ip,
			            port: 22
			        }, function() {
			            clearTimeout(timeout);
			            client.destroy();
			            return deferred.resolve(true);
			        });
			        client.on('error', function(err) {
			            clearTimeout(timeout);
			            client.destroy();
			            return deferred.resolve(false);
			        });
			        return deferred.promise;
		    	}

				function check() {
				    return isSshAvailable().then(function (available) {
				    	function wait () {
					    	API.console.verbose("Waiting for port 22 to open up ...");
					    	return API.Q.delay(5000).then(function() {
					    		return check();
					    	});				    		
				    	}
				    	if (available) {
					    	API.console.verbose("Port 22 is now open!");

					    	if (
					    		previousResolvedConfig &&
					    		previousResolvedConfig.status === "provisioned" &&
					    		previousResolvedConfig.vm &&
					    		previousResolvedConfig.vm._raw &&
					    		previousResolvedConfig.vm._raw.id &&
					    		resolvedConfig.vm._raw.id === previousResolvedConfig.vm._raw.id &&
					    		!keyFingerprintExists
					    	) {
					    		// If keyFingerprint file no longer exists we already checked
					    		// ssh access once.
					    		return;
					    	}

							return SSH.runRemoteCommands({
				                targetUser: resolvedConfig.dropplet.sshUser,
				                targetHostname: resolvedConfig.vm.ip,
				                commands: [
									"ls"
				                ],
				                workingDirectory: "/",
				                keyPath: resolvedConfig.dropplet.keyPath,
				                timeout: 10
		                    }).fail(function (err) {
								console.error("ERROR: SSH not yet ready: " + err.stack);
						    	return wait();
		                    });
				    	}
				    	return wait();
					});
				}

				return API.Q.timeout(check(), 120 * 1000).fail(function(err) {
					console.error("ERROR: Timeout waiting for SSH to become available.");
		    		throw err;
		    	});
		    }

			return api.ensure().then(function () {

				return ensureSSH().then(function () {
					resolvedConfig.status = "provisioned";
					if (keyFingerprintExists) {
						return api.removeKey(API.FS.readFileSync(keyFingerprintPath, "utf8")).then(function () {
							API.FS.removeSync(keyFingerprintPath);
							return;
						});
					}
					return;
				});

			}).then(function() {
				return resolvedConfig;
		    });
		});
	}

	exports.turn = function (resolvedConfig) {

console.log("TURN PINF TO DIGITAL OCEAN - resolvedConfig", resolvedConfig);


// TODO: Deploy remote environment boorstrap code via SSH if changed.

console.log("TODO: Upload ", resolvedConfig.sourcePath);


	}

	return exports;
}



/*

adapter.prototype.terminate = function(vm) {
	var self = this;

	return self._getByName(vm.name).then(function(vmInfo) {
		if (vmInfo) {
			console.log(("Terminating: " + JSON.stringify(vmInfo, null, 4)).magenta);
			return self._api.dropletsDeleteDroplet(vmInfo._raw.id).then(function(eventId) {
				// TODO: Optionally wait until destroyed?
			});
		}
		return Q.reject("VM with name '" + vm.name + "' not found!");
	});
}





*/
