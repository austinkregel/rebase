import { describe, it, expect } from 'vitest'
import {
  baseName,
  defaultRootForPlatform,
  isWindowsPath,
  isWindowsPlatform,
  joinPath,
  parentDir,
} from './paths'

describe('isWindowsPlatform', () => {
  it('detects Windows from gopsutil platform strings', () => {
    expect(isWindowsPlatform('Microsoft Windows 11 Pro')).toBe(true)
    expect(isWindowsPlatform('windows')).toBe(true)
  })
  it('treats unix-y platforms as non-Windows', () => {
    expect(isWindowsPlatform('ubuntu')).toBe(false)
    expect(isWindowsPlatform('darwin')).toBe(false)
    expect(isWindowsPlatform(undefined)).toBe(false)
  })
})

describe('defaultRootForPlatform', () => {
  it('roots Windows agents at C:\\ and everything else at /', () => {
    expect(defaultRootForPlatform('Microsoft Windows 10')).toBe('C:\\')
    expect(defaultRootForPlatform('ubuntu')).toBe('/')
    expect(defaultRootForPlatform('darwin')).toBe('/')
    expect(defaultRootForPlatform(undefined)).toBe('/')
  })
})

describe('isWindowsPath', () => {
  it('recognizes drive letters', () => {
    expect(isWindowsPath('C:\\')).toBe(true)
    expect(isWindowsPath('D:\\Users\\me')).toBe(true)
    expect(isWindowsPath('c:/mixed/slashes')).toBe(true)
  })
  it('treats posix paths as non-Windows', () => {
    expect(isWindowsPath('/')).toBe(false)
    expect(isWindowsPath('/home/me')).toBe(false)
  })
  it('does not misclassify a POSIX path containing a backslash', () => {
    // A backslash is a legal filename character on POSIX; only a drive letter
    // makes a path Windows-style.
    expect(isWindowsPath('/tmp/weird\\name')).toBe(false)
    expect(isWindowsPath('relative\\thing')).toBe(false)
  })
})

describe('joinPath', () => {
  it('joins Windows paths with backslashes', () => {
    expect(joinPath('C:\\', 'Users')).toBe('C:\\Users')
    expect(joinPath('C:\\Users', 'me')).toBe('C:\\Users\\me')
  })
  it('joins posix paths with forward slashes', () => {
    expect(joinPath('/', 'etc')).toBe('/etc')
    expect(joinPath('/home', 'me')).toBe('/home/me')
  })
})

describe('baseName', () => {
  it('returns the final segment', () => {
    expect(baseName('/home/me/file.txt')).toBe('file.txt')
    expect(baseName('/home/me/')).toBe('me')
    expect(baseName('C:\\Users\\me')).toBe('me')
  })
})

describe('parentDir', () => {
  it('returns the containing directory (posix)', () => {
    expect(parentDir('/home/me/file.txt')).toBe('/home/me')
    expect(parentDir('/etc')).toBe('/')
    expect(parentDir('/')).toBe('/')
  })
  it('returns the containing directory (windows)', () => {
    expect(parentDir('C:\\Users\\me\\file.txt')).toBe('C:\\Users\\me')
    expect(parentDir('C:\\Users')).toBe('C:\\')
  })
})
