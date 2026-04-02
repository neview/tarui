const path = require('path')
const fs = require('fs')
const util = require('util')
const COS = require('cos-nodejs-sdk-v5')

const promisifyReaddir = util.promisify(fs.readdir)
const promisifyStat = util.promisify(fs.stat)

const params = JSON.parse(process.argv[2])

const TencentConfig = {
  SecretId: params.SecretId,
  SecretKey: params.SecretKey,
  Region: params.Region,
  Bucket: params.Bucket
}

const client = new COS({
  SecretId: TencentConfig.SecretId,
  SecretKey: TencentConfig.SecretKey
})

const publicPath = params.distPath

function uploadFile(filePath, fileName) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath)
    client.putObject(
      {
        Bucket: TencentConfig.Bucket,
        Region: TencentConfig.Region,
        Key: fileName,
        StorageClass: 'STANDARD',
        Body: fileStream,
        ContentLength: fs.statSync(filePath).size,
        onProgress: function () {}
      },
      function (err, data) {
        if (err) {
          console.log(`上传失败: ${fileName} - ${err.message}`)
          reject(err)
        } else {
          console.log(`上传成功: ${fileName}`)
          resolve(data)
        }
      }
    )
  })
}

async function run(proPath = '') {
  const rootPath = `${publicPath}${proPath}`
  const dir = await promisifyReaddir(rootPath)

  for (let i = 0; i < dir.length; i++) {
    let filePath = path.resolve(rootPath, dir[i])
    const stat = await promisifyStat(filePath)
    if (stat.isFile()) {
      let fileName = `${proPath}/${dir[i]}`
      await uploadFile(filePath, fileName)
    } else if (stat.isDirectory()) {
      await run(`${proPath}/${dir[i]}`)
    }
  }
}

run()
  .then(() => {
    console.log('所有文件上传完成')
    process.exit(0)
  })
  .catch((err) => {
    console.error('上传过程出错:', err.message)
    process.exit(1)
  })
