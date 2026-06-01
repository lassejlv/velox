// node:constants — the legacy combined constants module (fs file-mode + access
// flags, signal numbers, errno). Values are Darwin (macOS), since velox is
// macOS-only. Many libraries (graceful-fs, fs-extra, mkdirp) `require(
// 'constants')` for `O_*`/`S_*` flags.

var os = require('node:os');

module.exports = {
  // access(2)
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,

  // open(2) flags (Darwin)
  O_RDONLY: 0x0000, O_WRONLY: 0x0001, O_RDWR: 0x0002,
  O_NONBLOCK: 0x0004, O_APPEND: 0x0008, O_SYNC: 0x0080,
  O_NOFOLLOW: 0x0100, O_CREAT: 0x0200, O_TRUNC: 0x0400, O_EXCL: 0x0800,
  O_NOCTTY: 0x20000, O_DIRECTORY: 0x100000, O_SYMLINK: 0x200000,
  O_DSYNC: 0x400000, O_CLOEXEC: 0x1000000,

  // file type bits (st_mode & S_IFMT)
  S_IFMT: 0xf000, S_IFIFO: 0x1000, S_IFCHR: 0x2000, S_IFDIR: 0x4000,
  S_IFBLK: 0x6000, S_IFREG: 0x8000, S_IFLNK: 0xa000, S_IFSOCK: 0xc000,

  // permission bits
  S_IRWXU: 0o700, S_IRUSR: 0o400, S_IWUSR: 0o200, S_IXUSR: 0o100,
  S_IRWXG: 0o070, S_IRGRP: 0o040, S_IWGRP: 0o020, S_IXGRP: 0o010,
  S_IRWXO: 0o007, S_IROTH: 0o004, S_IWOTH: 0o002, S_IXOTH: 0o001,
  S_ISUID: 0o4000, S_ISGID: 0o2000, S_ISVTX: 0o1000,

  // copyFile flags
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  UV_FS_COPYFILE_EXCL: 1, UV_FS_COPYFILE_FICLONE: 2, UV_FS_COPYFILE_FICLONE_FORCE: 4,

  // Signals + errno (from os.constants).
  ...(os.constants.signals || {}),
  ...(os.constants.errno || {}),
};
module.exports.default = module.exports;
