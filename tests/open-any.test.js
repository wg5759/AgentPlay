const test = require('node:test')
const assert = require('node:assert/strict')
const { splitOpenAnyPaths } = require('../electron/open-any')

function harness() {
  const approvals = []
  return {
    approvals,
    inspectDocuments: (paths) => {
      if (paths[0].endsWith('.docx') || paths[0].endsWith('.pdf')) {
        return [{ path: paths[0], name: paths[0].split('/').pop(), ext: paths[0].slice(paths[0].lastIndexOf('.')), size: 100 }]
      }
      throw new Error('不支持的文档格式')
    },
    isMediaPath: (filePath, ext) => ['.mp4', '.mkv', '.mp3', '.jpg'].includes(ext),
    approveDocument: (file) => {
      approvals.push(file.path)
      return { token: `token-${approvals.length}`, name: file.name, ext: file.ext, size: file.size }
    }
  }
}

test('open-any 分流：文档授权、媒体放行、未知跳过', () => {
  const { media, documents } = splitOpenAnyPaths(['D:/视频.mp4', 'D:/合同.docx', 'D:/扫描.pdf', 'D:/程序.exe'], harness())
  assert.deepEqual(media, ['D:\\视频.mp4'])
  assert.equal(documents.length, 2)
  assert.equal(documents[0].token, 'token-1')
  assert.equal(documents[1].ext, '.pdf')
})

test('文档校验失败的媒体扩展名回退到播放器', () => {
  const { media, documents } = splitOpenAnyPaths(['D:/照片.jpg'], harness())
  assert.deepEqual(documents, [])
  assert.deepEqual(media, ['D:\\照片.jpg'])
})

test('超过 20 个文件截断且顺序稳定', () => {
  const paths = Array.from({ length: 25 }, (_, index) => `D:/视频${index + 1}.mp4`)
  const { media } = splitOpenAnyPaths(paths, harness())
  assert.equal(media.length, 20)
  assert.ok(media[0].endsWith('视频1.mp4'))
})
