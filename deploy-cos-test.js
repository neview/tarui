const path = require('path')
const fs = require('fs')
const util = require('util')
const COS = require('cos-nodejs-sdk-v5')

const promisifyReaddir = util.promisify(fs.readdir)
const promisifyStat = util.promisify(fs.stat)

const TencentConfig = {
  SecretId: '',
  SecretKey: '',
  Region: '',
  Bucket: ''
}

const client = new COS({
  SecretId: TencentConfig.SecretId,
  SecretKey: TencentConfig.SecretKey
})

const publicPath = path.resolve(__dirname, './dist')

async function run(proPath = '') {
  //文件根目录路径
  const rootPath = `${publicPath}${proPath}`
  const dir = await promisifyReaddir(rootPath)

  for (let i = 0; i < dir.length; i++) {
    //文件完整路径+文件名
    let filePath = path.resolve(rootPath, dir[i])
    const stat = await promisifyStat(filePath)
    if (stat.isFile()) {
      //文件流
      const fileStream = fs.createReadStream(filePath)
      //文件名
      let fileName = `${proPath}/${dir[i]}`
      console.log(`上传文件: ${fileName}`)
      client.putObject(
        {
          Bucket: TencentConfig.Bucket /* 填入您自己的存储桶，必须字段 */,
          Region: TencentConfig.Region /* 存储桶所在地域，例如ap-beijing，必须字段 */,
          Key: fileName /* 存储在桶里的对象键（例如1.jpg，a/b/test.txt），必须字段 */,
          StorageClass: 'STANDARD',
          /* 当Body为stream类型时，ContentLength必传，否则onProgress不能返回正确的进度信息 */
          Body: fileStream, // 上传文件对象
          ContentLength: fs.statSync(filePath).size,
          onProgress: function (progressData) {
            // console.log(JSON.stringify(progressData));
          }
        },
        function (err, data) {
          // console.log(err || data);
        }
      )
    } else if (stat.isDirectory()) {
      await run(`${proPath}/${dir[i]}`)
    }
  }
}

run()
