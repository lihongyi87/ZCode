import io

base = io.open('.base-full.ts', encoding='utf-8').read()
fnidx = base.find('export function buildPostCompactReadStateReminderEntries')
# 直接取函数声明行到文件尾(含全部后续私有 helper 与其函数体)
tail = base[fnidx:]
io.open('.base-tail.ts', 'w', encoding='utf-8', newline='\n').write(tail)
print('tail chars:', len(tail), 'lines:', tail.count('\n') + 1)
print('first line:', tail.split('\n')[0])
