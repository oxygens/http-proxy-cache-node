const http = require("http");
const HTTPProxy = require("http-proxy");
const url = require("url");
const fs = require("fs-promise");
const path = require("path");
const sleep = require("sleep-promise");

const stream = require("stream");
stream.copy = require("stream-copy").copy;


module.exports = 
class HTTPProxyCache
{
	/**
	 * @param {string} strTargetURLBasePath 
	 * @param {number} nBytesMinimumFileSize 
	 * @param {string} strCacheDirectoryRootPath 
	 */
	constructor(strTargetURLBasePath, nBytesMinimumFileSize, strCacheDirectoryRootPath)
	{
		this._strTargetURLBasePath = strTargetURLBasePath.split("?")[0].split("#")[0];
		this._nBytesMinimumFileSize = nBytesMinimumFileSize;
		this._strCacheDirectoryRootPath = strCacheDirectoryRootPath;

		this._proxy = HTTPProxy.createProxyServer();
	}


	/**
	 * @param {http.IncomingRequest} incomingRequest 
	 * @param {http.ServerResponse} serverResponse 
	 */
	async processHTTPRequest(incomingRequest, serverResponse)
	{
		const objParsedURL = url.parse(incomingRequest.url);

		if(
			incomingRequest.method === "GET"
			&& !objParsedURL.pathname.includes("..")
		)
		{	
			var requestOptions = {
				method: "HEAD", 
				host: url.parse(this._strTargetURLBasePath).hostname, 
				port: objParsedURL.port ? objParsedURL.port : 80, 
				path: objParsedURL.path
			};


			// Obtain headers with a HEAD request.
			// Content-length is used to determine if the file is big enough to warrant caching.
			// Last-modified is used to determine if the file has changed in the meantime.
			serverResponse.headers = await new Promise((fnResolve, fnReject) => {
				const req = http.request(requestOptions, function(_incomingMessage) {
					fnResolve(_incomingMessage.headers);
				});

				req.on("error", fnReject);

				req.end();
			});


			if(
				serverResponse.headers["content-length"]
				&& serverResponse.headers["content-length"] >= this._nBytesMinimumFileSize
			)
			{
				if(
					!fs.existsSync(this._strCacheDirectoryRootPath)
					|| (
						serverResponse.headers["content-length"]
						&& fs.statSync(this._strCacheDirectoryRootPath).size !== parseInt(serverResponse.headers["content-length"], 10)
					)
					|| (
						serverResponse.headers["last-modified"]
						&& Math.floor(fs.statSync(this._strCacheDirectoryRootPath).mtime.getTime() / 1000) !== Math.floor(new Date(serverResponse.headers["last-modified"]).getTime() / 1000)
					)
				)
				{
					requestOptions.method = "GET";

					// Synchronous mode to almost guarantee no concurrency in creating the missing directories.
					let strPathSoFar = "";

					for(let strFolderName of path.dirname(this._strCacheDirectoryRootPath).split(path.sep))
					{
						strPathSoFar += strFolderName + path.sep;
						
						if(!fs.existsSync(strPathSoFar))
						{
							fs.mkdirSync(strPathSoFar);
						}
					}

					try
					{
						await new Promise(async (fnResolve, fnReject) => {
							//let nStreamsFinished = 0;


							const wstream = fs.createWriteStream(this._strCacheDirectoryRootPath);

							wstream.on("error",	fnReject);
							
							wstream.on(
								"finish", 
								async () => {
									//if(++nStreamsFinished >= 2)
									//{
										//fnResolve();
									//}
								}
							);


							serverResponse.on("error", fnReject);
							serverResponse.on("close", () => {
								fnReject(new Error("Connection closed before sending the whole response."));
							});

							serverResponse.on(
								"finish", 
								async () => {
									serverResponse.statusCode = 200;
									serverResponse.end();

									// The 'finish' event is never fired on wstream for some reason.
									// Forcibly calling wstream.end() will fire the 'finish' event... (uselessly).
									await sleep(20);
									wstream.end();

									//if(++nStreamsFinished >= 2)
									//{
										//fnResolve();
									//}
									fnResolve();
								}
							);


							const req = http.request(requestOptions, function(_incomingMessage) {
								stream.copy(serverResponse, wstream);
								_incomingMessage.pipe(serverResponse);
							});
							
							req.on("error", fnReject);

							req.end();
						});
					}
					catch(error)
					{
						console.log(error);
						serverResponse.statusCode = 500;
						serverResponse.end();
						return;
					}


					// Somehow the write stream has some sort of delay in updating the modified date (OS thing?).
					// Writing the time later.
					setTimeout(
						async () => {
							const nUnixTimeSeconds = Math.floor(new Date(serverResponse.headers["last-modified"]).getTime() / 1000);
							await fs.utimes(this._strCacheDirectoryRootPath, nUnixTimeSeconds, nUnixTimeSeconds);
						},
						1000
					);

					return;
				}
				else if(await fs.exists(this._strCacheDirectoryRootPath))
				{
					await new Promise(async (fnResolve, fnReject) => {
						serverResponse.headers["content-type"] = "application/octet-stream";
						delete serverResponse.headers["content-encoding"];

						var rstream = fs.createReadStream(this._strCacheDirectoryRootPath);
						rstream.pipe(serverResponse);

						rstream.on(
							"error",
							(error) => {
								serverResponse.statusCode = 500;
								serverResponse.end();

								fnReject(error);
							}
						);

						rstream.on(
							"end",
							() => {
								serverResponse.statusCode = 200;
								serverResponse.end();
								
								fnResolve();
							}
						);
					});

					return;
				}
			}
		}

		this._proxy.web(
			incomingRequest, 
			serverResponse, 
			{
				target: this._strTargetURLBasePath
			}
		);
	}
};


