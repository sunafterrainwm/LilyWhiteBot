/*
 * 集中處理檔案：將檔案上傳到圖床，取得 URL 並儲存至 context 中
 *
 * 已知的問題：
 * Telegram 音訊使用 ogg 格式，QQ 則使用 amr 和 silk，這個可以考慮互相轉換一下
 *
 */
'use strict';

const { AbortController } = require('node-abort-controller');
const { default: axios } = require('axios');
const crypto = require('crypto');
const FormData = require( 'form-data' );
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const stream = require( 'stream' );
const winston = require('winston');
const fileType = require('file-type');

let options = {};
let servemedia;
let handlers;

const pkg = require('../../package.json');
const USERAGENT = `LilyWhiteBot/${pkg.version} (${pkg.repository})`;

class FetchStream extends stream.Transform {
    constructor( url, config ) {
        super();
        this.url = url;
        this.config = config;
        this._doFetch();
    }

    async _doFetch() {
        try {
            const res = await axios.get(this.url, Object.assign({}, this.config, {
                responseType: 'stream'
            }));
            res.data.pipe(this);
        } catch ( error ) {
            this.emit('error', error);
        } finally {
            this.end();
        }
    }

    _transform(chunk, encoding, callback) {
        this.push(chunk, encoding);
        callback();
    }
}


/**
 * 根据已有文件名生成新文件名
 * @param {string} name 文件名
 * @returns {string} 新文件名
 */
const generateFileName = (url, name) => {
    let extName = path.extname(name || '');
    if (extName === '') {
        extName = path.extname(url || '');
    }
    if (extName === '.webp') {
        extName = '.png';
    }
    return crypto.createHash('md5').update(name || (Math.random()).toString()).digest('hex') + extName;
};

/**
 * 将各聊天软件的媒体类型转成标准类型
 * @param {string} type 各Handler提供的文件类型
 * @returns {string} 统一文件类型
 */
const convertFileType = (type) => {
    switch (type) {
        case 'sticker':
            return 'image';
        case 'voice':
            return 'audio';
        case 'video':
        case 'document':
            return 'file';
        default:
            return type;
    }
};

const createTimeoutAbortSignal = (timeOut) => {
    const controller = new AbortController();
    setTimeout(function () {
        controller.abort('Timeout.');
    }, timeOut);
    return controller.signal;
}

const createFormData = (data) => {
    const formData = new FormData();
    for (const [name, value, filename] of data) {
        formData.append(name, value, {
            filename
        });
    }
    return formData;
}

/**
 * 下载/获取文件内容，对文件进行格式转换（如果需要的话），然后管道出去
 * @param {*} file 
 * @param {*} pipe 
 * @returns {Promise}
 */
const getFileStream = (file) => {
    let filePath = file.url || file.path;
    let fileStream;

    if (file.url) {
        fileStream = new FetchStream(file.url);
    } else if (file.path) {
        fileStream = fs.createReadStream(file.path);
    } else {
        throw new TypeError('unknown file type');
    }

    // Telegram默认使用webp格式，转成png格式以便让其他聊天软件的用户查看
    if ((file.type === 'sticker' || file.type === 'image') && path.extname(filePath) === '.webp') {
        // if (file.type === 'sticker' && servemedia.stickerMaxWidth !== 0) {
        //     // 缩小表情包尺寸，因容易刷屏
        //     fileStream = fileStream.pipe(sharp().resize(servemedia.stickerMaxWidth || 256).png());
        // } else {
            fileStream = fileStream.pipe(sharp().png());
        // }
    }
    
    // if (file.type === 'record') {
    //   // TODO: 語音使用silk格式，需要wx-voice解碼
    // }

    return fileStream;

};

const pipeFileStream = (file, pipe) => new Promise((resolve, reject) => {
    let fileStream = getFileStream(file);
    fileStream.on('error', e => reject(e))
        .on('end', () => resolve())
        .pipe(pipe);
});

/*
 * 儲存至本機快取
 */
const uploadToCache = async (file) => {
    let targetName = generateFileName(file.url || file.path, file.id);
    let targetPath = path.join(servemedia.cachePath, targetName);
    let writeStream = fs.createWriteStream(targetPath).on('error', (e) => { throw e; });
    await pipeFileStream(file, writeStream);
    return servemedia.serveUrl + targetName;
};

/*
 * 上传到各种图床
 */
const uploadToHost = (host, file) => new Promise((resolve, reject) => {
    const requestOptions = {
        timeout: servemedia.timeout || 3000,
        signal: createTimeoutAbortSignal( servemedia.timeout ?? 30000 ),
        headers: {
            'Content-Type': 'multipart/form-data'
        },
        responseType: 'text'
    };

    let name = generateFileName(file.url || file.path, file.id);
    let pendingFileStream = getFileStream(file);
    
    // p4: reject .exe (complaint from the site admin)
    if (path.extname(name) === '.exe') {
        reject('We wont upload .exe file');
        return;
    }

    let buf = []
    pendingFileStream
        .on('data', d => buf.push(d))
        .on('end', async () => {
            let pendingFile = Buffer.concat(buf);
            if (!path.extname(name)) {
                let type = await fileType.fromBuffer(pendingFile);
                if (type) name += '.' + type.ext;
            }

            switch (host) {
                case 'vim-cn':
                case 'vimcn':
                    requestOptions.url = 'https://img.vim-cn.com/';
                    requestOptions.data = createFormData([
                        ['name', pendingFile, name]
                    ]);
                    break;

                case 'sm.ms':
                    requestOptions.url = 'https://sm.ms/api/upload';
                    requestOptions.data = createFormData([
                        ['smfile', pendingFile, name]
                    ]);
                    break;

                case 'imgur':
                    if (servemedia.imgur.apiUrl.endsWith('/')) {
                        requestOptions.url = servemedia.imgur.apiUrl + 'upload';
                    } else {
                        requestOptions.url = servemedia.imgur.apiUrl + '/upload';
                    }
                    requestOptions.headers.Authorization = `Client-ID ${servemedia.imgur.clientId}`;
                    requestOptions.data = createFormData([
                        ['type', 'file'],
                        ['image', pendingFile, name]
                    ]);
                    break;

                case 'uguu':
                case 'Uguu':
                    requestOptions.url = servemedia.uguuApiUrl || servemedia.UguuApiUrl; // 原配置文件以大写字母开头
                    requestOptions.data = createFormData([
                        ['file', pendingFile, name],
                        ['randomname', 'true']
                    ]);
                    break;
                    
                case 'lsky':
                    requestOptions.url = servemedia.lsky.apiUrl;
                    if (servemedia.lsky.token) {
                        requestOptions.headers.token = servemedia.lsky.token;
                    }
                    requestOptions.data = createFormData([
                        ['image', pendingFile, name],
                    ]);
                    break;
                    
                default:
                    reject(new Error('Unknown host type'));
            }

            axios.postForm(requestOptions.url, requestOptions).then((response) => {
                if (response.status === 200) {
                    if (typeof body === 'string') body = JSON.parse(body);
                    switch (host) {
                        case 'vim-cn':
                        case 'vimcn':
                            resolve(String(response.data).trim().replace('http://', 'https://'));
                            break;
                        case 'uguu':
                        case 'Uguu':
                            resolve(String(response.data).trim());
                            break;
                        case 'sm.ms':
                            const sJson = JSON.parse(response.data);
                            if (sJson && sJson.code !== 'success') {
                                reject(new Error(`sm.ms return: ${sJson.msg}`));
                            } else {
                                resolve(sJson.data.url);
                            }
                            break;
                        case 'imgur':
                            const iJson = JSON.parse(response.data);
                            if (iJson && !iJson.success) {
                                reject(new Error(`Imgur return: ${iJson.data.error}`));
                            } else {
                                resolve(iJson.data.link);
                            }
                            break;
                        case 'lsky':
                            const lJson = JSON.parse(response.data);
                            if (lJson && lJson.code !== 200) {
                                reject(new Error(`Lsky return: ${lJson.msg}`));
                            } else {
                                resolve(lJson.data.url);
                            }
                            break;
                    }
                } else {
                    reject(new Error(error));
                }
            });
        });
});

/*
 * 上傳到自行架設的 linx 圖床上面
 */
const uploadToLinx = (file) => new Promise((resolve, reject) => {
    let name = generateFileName(file.url || file.path, file.id);

    const fileStream = getFileStream(file);
    axios.put(String( servemedia.linxApiUrl ) + name, fileStream, {
        signal: createTimeoutAbortSignal( servemedia.timeout ?? 30000 ),
        headers: {
            'Linx-Randomize': 'yes',
            'Accept': 'application/json'
        },
        responseType: 'text'
    }).then((response) => {
        if (response.status === 200) {
            resolve(JSON.parse(response.data).direct_url);
        } else {
            reject(new Error(String(response.data)));
        }
    }).catch(err => reject(err));
});

/*
 * 決定檔案去向
 */
const uploadFile = async (file) => {
    let url;
    let fileType = convertFileType(file.type);

    switch (servemedia.type) {
        case 'vimcn':
        case 'vim-cn':
        case 'uguu':
        case 'Uguu':
        case 'lsky':
            url = await uploadToHost(servemedia.type, file);
            break;

        case 'sm.ms':
        case 'imgur':
            // 公共图床只接受图片，不要上传其他类型文件
            if (fileType === 'image') {
                url = await uploadToHost(servemedia.type, file);
            }
            break;

        case 'self':
            url = await uploadToCache(file)
            break;

        case 'linx':
            url = await uploadToLinx(file)
            break;

        default:

    }

    if (url) {
        return {
            type: fileType,
            url: url
        };
    } else {
        return null;
    }
};

/*
 * 判斷訊息來源，將訊息中的每個檔案交給對應函式處理
 */
const fileUploader = {
    init: (opt) => {
        options = opt;
        servemedia = options.options.servemedia || {};
    },
    get handlers() { return handlers; },
    set handlers(h) { handlers = h; },
    process: async (context) => {
        // 上传文件
        // p4: dont bother with files from somewhere without bridges in config
        if (context.extra.clients > 1 && context.extra.files && servemedia.type && servemedia.type !== 'none') {
            let promises = [];
            let fileCount = context.extra.files.length;

            // 将聊天消息附带文件上传到服务器
            for (let [index, file] of context.extra.files.entries()) {
                if (servemedia.sizeLimit && servemedia.sizeLimit > 0 && file.size && file.size > servemedia.sizeLimit*1024) {
                    winston.debug(`[file.js] <FileUploader> #${context.msgId} File ${index+1}/${fileCount}: Size limit exceeded. Ignore.`);
                } else {
                    promises.push(uploadFile(file));
                }
            }

            // 整理上传到服务器之后到URL
            let uploads = (await Promise.all(promises)).filter(x => x);
            for (let [index, upload] of uploads.entries()) {
                winston.debug(`[file.js] <FileUploader> #${context.msgId} File ${index+1}/${uploads.length} (${upload.type}): ${upload.url}`);
            }

            return uploads;
        } else {
            return [];
        }
    },
};

module.exports = (bridge, options) => {
    fileUploader.init(options);
    fileUploader.handlers = bridge.handlers;

    axios.interceptors.request.use(function (config) {
        config.headers = config.headers || {};
        config.headers[ 'User-Agent' ] = servemedia.userAgent || USERAGENT;
        // Do something before request is sent
        return config;
    }, undefined, {synchronous: true});

    bridge.addHook('bridge.send', async (msg) => {
        try {
            msg.extra.uploads = await fileUploader.process(msg);
        } catch (e) {
            winston.error(`Error on processing files: `, e);
            msg.callbacks.push(new bridge.BridgeMsg(msg, {
                text: 'File upload error',
                isNotice: true,
                extra: {},
            }));
        }
    });
};
