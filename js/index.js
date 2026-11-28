const ipc = require('electron').ipcRenderer;
const remote = require('electron').remote;
const dialog = remote.dialog;
const shell = require('electron').shell;
const appData = require('./package.json');
const utils = require('./js/utils.js');
const userAgent = {
  desktop: 'bilimini Desktop like Mozilla/233 (Windows NT or OSX) AppleWebKit like Gecko or not (Chrome/99 and Safari/99 both OK)',
  mobile: 'bilimini Mobile like (iPhone or Android) whatever AppleWebKit/124.50 Mobile/BI233'
};
const videoUrlPrefix = 'https://www.bilibili.com/video/';
const liveUrlPrefix  = 'https://live.bilibili.com/blanc/';
let wv, wrapper;

// 去掉只影响统计、不影响页面内容的查询参数（如 vd_source、spm_id_from 等）
// 这些参数是 B 站前端自己 push 上去的，如果参与比较会误判成新页面导致重复重载、窗口闪烁
function normalizeUrl(url) {
  if( !url ) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete('vd_source');
    u.searchParams.delete('spm_id_from');
    u.searchParams.delete('from_source');
    u.searchParams.delete('from_spmid');
    u.searchParams.delete('share_source');
    u.searchParams.delete('share_medium');
    u.searchParams.delete('share_plat');
    u.searchParams.delete('share_session_id');
    u.searchParams.delete('share_tag');
    u.searchParams.delete('timestamp');
    u.searchParams.delete('unique_k');
    let search = u.searchParams.toString();
    return u.origin + u.pathname + (search ? '?' + search : '') + u.hash;
  } catch(e) {
    return url;
  }
}

// 保存用户浏览记录
let _lastNavigation = new Date();
var _history = {
  stack: ['https://m.bilibili.com/index.html'],
  pos: 0,
  lastTarget: '', // 这是最后一次传入go方法的url
  lastLoadedUrl: '', // 这是最后一次webview实际加载完成的url，这个是在下面webview的did-finish-load事件的时候更新的
  ignoreUntil: 0, // 在这之前 dirty-check 暂停工作，用于避免程序主动跳转被误判成用户操作
  pendingRefreshHome: false, // 标记「回到首页后还要再换一批推荐」
  go: function(target, noNewHistory) {
    // 防止重复加载同页面
    // 用规范化后的地址比较，避免 B 站自己 push 的统计参数（vd_source 等）造成误判重复加载
    if( normalizeUrl(target) == normalizeUrl(_history.lastTarget) ) {
      // utils.log(`代码尝试重复加载页面：${target}`);
      return false;
    }
    _history.lastTarget = target;
    // 程序主动跳转，先让 dirty-check 停 1.5s，等 webview 的地址真正切过去再恢复检测
    _history.ignoreUntil = Date.now() + 1500;
    // 显示loading mask
    wrapper.classList.add('loading');
    let vid = utils.getVidWithP(target);
    let live;
    // 如果两次转跳的时间间隔小于3s，就认为是B站发起的redirect
    // 这时为保证后退时不会陷入循环，手动删除一条历史
    const now = new Date();
    if( now - _lastNavigation < 3000 ) {
      utils.log('两次转跳间隔小于3s，疑似redirect');
      _history.pop();
    }
    _lastNavigation = now;
    if( vid ) {
      // case 1 普通视频播放页，转跳对应pc页
      // 先切窗口再加载，避免页面按旧尺寸渲染完再缩小，看起来像闪了一下
      applyWindowType(getWindowTypeByUrl(videoUrlPrefix + vid));
      wv.loadURL(videoUrlPrefix + vid, {
        userAgent: userAgent.desktop
      });
      !noNewHistory && _history.add(videoUrlPrefix + vid);
      v.disableDanmakuButton = false;
      utils.log(`路由：类型① 视频详情页\n原地址：${target}\n转跳地址：${videoUrlPrefix+vid}`);
    } else if( target.indexOf('bangumi/play/') > -1 ) {
      // case 2 番剧播放页
      wv.loadURL(target, {
        userAgent: userAgent.desktop
      });
      !noNewHistory && _history.add(target);
      v.disableDanmakuButton = false;
      utils.log(`路由：类型② 番剧播放页\n地址：${target}`);
    } else if ( live = /live\.bilibili\.com\/(h5\/||blanc\/)?(\d+).*/.exec(target) ) {
      wv.loadURL(liveUrlPrefix + live[2], {
        userAgent: userAgent.desktop
      });
      !noNewHistory && _history.add(liveUrlPrefix + live[2]);
      v.disableDanmakuButton = false;
      utils.log(`路由：类型③ 直播页面\n原地址：${target}\n转跳地址：${liveUrlPrefix+live[2]}`);
    } else if( target.indexOf('space.bilibili.com') > -1 &&
              (target.indexOf('/favlist') > -1 || target.indexOf('/channel/') > -1) ) {
      // case 4 收藏夹、合集/收藏列表
      // 桌面版收藏页只有 PC 排版，用手机 UA 打开会被重定向回 m.bilibili.com/space 导致内容丢失
      // 但直接加载桌面页又会把窗口撑到 1000×700，和主页排版不一致
      // 所以这里转成移动端个人空间页，由 inject.js 在其 tab 栏补「收藏」入口并在页内渲染收藏内容
      const mid = /space\.bilibili\.com\/(\d+)/.exec(target);
      const mobileSpace = mid ? `https://m.bilibili.com/space/${mid[1]}` : target;
      wv.loadURL(mobileSpace, {
        userAgent: userAgent.mobile
      });
      !noNewHistory && _history.add(mobileSpace);
      ipc.send('update-part', null);
      v.disableDanmakuButton = true;
      utils.log(`路由：类型④ 收藏夹/合集\n原地址：${target}\n转跳地址：${mobileSpace}`);
    } else if( target.indexOf('www.bilibili.com/list/') > -1 ||
               target.indexOf('www.bilibili.com/medialist/') > -1 ) {
      // 合集/收藏列表页没有移动版，只能用桌面 UA 打开
      wv.loadURL(target, {
        userAgent: userAgent.desktop
      });
      !noNewHistory && _history.add(target);
      ipc.send('update-part', null);
      v.disableDanmakuButton = true;
      utils.log(`路由：类型④ 合集/收藏列表（桌面页）\n地址：${target}`);
    } else {
      // 其他链接不做操作直接打开
      wv.loadURL(target, {
        userAgent: userAgent.mobile
      });
      !noNewHistory && _history.add(target);
      // 清除分p
      ipc.send('update-part', null);
      v.disableDanmakuButton = true;
      utils.log(`路由：类型⑤ 未归类\n原地址：${target}\n转跳地址：${target}`);
    }
  },
  goPart: function(pid) {
    wrapper.classList.add('loading');
    // 因为utils.getVidWithP返回的地址是通用的，里面可能已经带了/?p=，所以这里我们单独获取吧
    const vid = utils.getVid(wv.getURL());
    if(vid) {
      let url = `${videoUrlPrefix}${vid}/?p=${pid}`;
      wv.loadURL(url, {
        userAgent: userAgent.desktop
      });
      _history.replace(url);
      utils.log(`路由：选择分p，选中第${pid}，转跳地址：${url}`);
    }
  },
  goBangumiPart(ep) {
    utils.log(`路由：选择番剧分p`);
    _history.go(videoUrlPrefix + ep.bvid);
  },
  add: function(url) {
    // 丢掉当前位置往后的history
    _history.stack.length = _history.pos + 1;
    _history.stack.push(url);
    _history.pos++;
  },
  replace: function(url) {
    _history.stack[_history.stack.length - 1] = url;
  },
  pop: function() {
    _history.stack.pop();
    _history.pos--;
  },
  goBack: function() {
    if(!_history.canGoBack()) {
      return false;
    }
    utils.log('路由：后退');
    _history.go(_history.stack[--_history.pos], true);
  },
  goForward: function() {
    if(!_history.canGoForward()) {
      return false;
    }
    utils.log('路由：前进');
    _history.go(_history.stack[++_history.pos], true);
  },
  canGoBack: function() {
    return _history.pos > 0;
  },
  canGoForward: function() {
    return _history.pos + 1 < _history.stack.length;
  }
};

function getPartOfVideo(vid) {
  utils.ajax.get(videoUrlPrefix + vid, (res = '') => {
    // 分 P 信息存储在 window.__INITIAL_STATE__= 中 根据 object 类型的特性最后一个 } 后面不会有 , ] } 使用正则匹配
    const match = res.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\})[^,\]\}]/m)
    if (!match[1]) {
      utils.log('获取番剧分p数据失败', res);
      return false;
    }
    const json = JSON.parse(match[1]);
    let parts;
    try {
      parts = json.videoData.pages;
    } catch(err) {
      utils.log(`解析视频分p失败：${err}`, json);
      return false;
    }
    utils.log(`获取视频 ${vid} 的分P数据成功`);
    if( parts.length ) {
      ipc.send('update-part', parts.map(p => p.part));
      // 有超过1p时自动开启分p窗口
      if( parts.length > 1 ) {
        ipc.send('show-select-part-window');
        v.disablePartButton = false;
      }
    } else {
      ipc.send('update-part', null);
      v.disablePartButton = true;
    }
  });
}

function getPartOfBangumi(url) {
  utils.ajax.get(url, (res = '') => {
    // 分 P 信息存储在 window.__INITIAL_STATE__= 中 根据 object 类型的特性最后一个 } 后面不会有 , ] } 使用正则匹配
    const match = res.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\})[^,\]\}]/m)
    if (!match[1]) {
      utils.log('获取番剧分p数据失败', res);
      return false;
    }
    const json = JSON.parse(match[1]);
    let parts;
    let currentPartId = 0;
    try {
      parts = json.epList;
      currentPartId = json.epInfo.i;
    } catch(err) {
      utils.log(`解析番剧分p失败：${err}`, json);
      return false;
    }
    utils.log(`获取番剧 ${url} 的分P数据成功`);
    if( parts.length ) {
      ipc.send('update-bangumi-part', {
        currentPartId,
        parts: parts.map(p => {
          return {
            epid: p.i,
            aid: p.aid,
            bvid: p.bvid,
            title: p.longTitle
          };
        })
      });
      if( parts.length > 1 ) {
        ipc.send('show-select-part-window');
        v.disablePartButton = false;
      }
    } else {
      ipc.send('update-part', null);
      v.disablePartButton = true;
    }
  });
}

// UI逻辑
const v = new Vue({
  el: '#wrapper',
  data: {
    version: remote.app.getVersion(),
    naviCanGoBack: false,
    naviCanGoForward: false,
    showAboutOverlay: false,
    disableDanmakuButton: true,
    disablePartButton: true,
    // 倍速：只在播放页可用，不跨视频记忆
    speedOptions: [0.75, 1.0, 1.25, 2.0],
    currentSpeed: 1,
    speedMenuShow: false,
    disableSpeedButton: true
  },
  methods: {
    // 倍速显示：0.75x / 1x / 1.25x / 2x
    fmtSpeed: function(s) {
      return (Math.round(s * 100) / 100) + 'x';
    },
    // 显示倍速菜单（鼠标悬停按钮时）
    showSpeedMenu: function() {
      if(this.disableSpeedButton) {
        return false;
      }
      clearTimeout(this._hideSpeedTimer);
      this.speedMenuShow = true;
    },
    // 鼠标离开按钮/菜单后稍作延迟再收起，留出移入菜单的时间
    scheduleHideSpeedMenu: function() {
      clearTimeout(this._hideSpeedTimer);
      this._hideSpeedTimer = setTimeout(() => {
        this.speedMenuShow = false;
      }, 220);
    },
    cancelHideSpeedMenu: function() {
      clearTimeout(this._hideSpeedTimer);
    },
    toggleSpeedMenu: function() {
      if(this.disableSpeedButton) {
        return false;
      }
      this.speedMenuShow = !this.speedMenuShow;
    },
    // 选中一个倍速档位
    selectSpeed: function(s) {
      if(this.disableSpeedButton) {
        return false;
      }
      this.currentSpeed = s;
      this.speedMenuShow = false;
      utils.log(`主窗口：设置倍速 ${this.fmtSpeed(s)}`);
      wv.send('set-speed', s);
    },
    // 后退
    naviBack: function() {
      _history.goBack();
    },
    // 前进
    naviForward: function() {
      _history.goForward();
    },
    // 回到首页
    naviGoHome: function() {
      _history.go('https://m.bilibili.com/index.html');
    },
    // 刷新主页：换一批推荐视频
    // 首页推荐是服务端直出的，单纯 reload 会拿到同一批内容，
    // 所以这里通知注入脚本走推荐接口 fresh_idx 拿新数据；在别的页面则先回首页
    naviReload: function() {
      utils.log('主窗口：点击刷新主页');
      const onHome = /^https:\/\/m\.bilibili\.com\/(index\.html)?(\?.*)?$/.test(wv.getURL());
      if( onHome ) {
        wrapper.classList.add('loading');
        wv.send('refresh-home');
      } else {
        // 不在首页：先回首页，等加载完成后再换一批推荐（由 did-finish-load 里的 pendingRefreshHome 触发）
        _history.pendingRefreshHome = true;
        _history.go('https://m.bilibili.com/index.html');
      }
    },
    // 关于
    showAbout: function() {
      utils.log('主窗口：点击关于');
      this.showAboutOverlay = !this.showAboutOverlay;
      wrapper.classList.toggle('showAbout');
    },
    hideAbout: function() {
      this.showAboutOverlay = false;
      wrapper.classList.remove('showAbout');
    },
    // 召唤选p窗口
    toggleSelectPartWindow: function() {
      if(this.disablePartButton) {
        return false;
      }
      utils.log('主窗口：点击P');
      ipc.send('toggle-select-part-window');
    },
    // 进入订阅
    showFeed() {
      utils.log('主窗口：点击订阅');
      _history.go('https://t.bilibili.com/?tab=8');
    },
    // 设置窗口
    toggleConfig: function() {
      utils.log('主窗口：点击设置');
      ipc.send('toggle-config-window');
    },
    // 关鸡 - 在osx下仅关闭当前窗口，在windows下直接退出整个程序
    turnOff: function() {
      utils.log('主窗口：点击退出');
      ipc.send('close-main-window');
    },
    // 显示、隐藏弹幕快捷键
    // pull request #1. Thanks to bumaociyuan
    toggleDanmaku: function() {
      if(this.disableDanmakuButton) {
        return false;
      }
      utils.log('主窗口：点击弹幕开关');
      // 新版 bpx 播放器的弹幕开关是 bpx-player-dm-switch 里的 checkbox（2023 后），
      // 旧版是 bilibili-player-video-danmaku-switch 里的 input（2018 适配）。
      // 两个都试，且查询不到时不再抛 null.click() 的页面错误
      wv.executeJavaScript(`
        (function(){
          var sw = document.querySelector('.bpx-player-dm-switch .bui-danmaku-switch-input') ||
                   document.querySelector('.bilibili-player-video-danmaku-switch .bui-switch-input');
          if( sw ) { sw.click(); return 'clicked'; }
          return 'switch-not-found';
        })()
      `);
    }
  }
});

// 给body加上platform flag
function detectPlatform() {
  if( process.platform.startsWith('win') ) {
    window.platform = 'win';
    document.body.classList.add('win');
  } else if( process.platform == 'darwin' ) {
    window.platform = 'darwin';
    document.body.classList.add('macos');
  }
}

// 检查更新
// 已移除：原版会请求作者服务器获取更新信息，但该服务已不可用，
// 且返回内容不一定是合法 JSON，会抛异常导致启动报错。这里不再发起任何网络请求。
function checkUpdateOnInit() {
  // 保留「每天只检查一次」的标记写入，避免旧配置里残留的日期判断逻辑产生副作用
  // 本项目为本地修改版，更新由使用者自行重新构建安装包
  return;
}

// 当用户缩放窗口时保存窗口尺寸
// 关键：程序自己切换窗口尺寸时也会触发 resize，那种情况下不能记录，
// 否则会把「播放页的临时尺寸」写进「主页的尺寸槽」，导致回主页时窗口形状错乱。
// 判断方式：记录每次程序设置的目标尺寸，resize 到达时若与目标一致（±3px，容忍 DPI 取整）就跳过。
// 不用「限时屏蔽」：Windows 对窗口调整有节流，resize 事件可能迟到，
// 时间窗口过期后程序尺寸仍会被当成用户拖动存进配置
var programSizes = {};
function saveWindowSizeOnResize() {
  var saveWindowSizeTimer;
  window.addEventListener('resize', function() {
    clearTimeout(saveWindowSizeTimer);
    saveWindowSizeTimer = setTimeout(function() {
      const newSize = [window.innerWidth, window.innerHeight];
      // 程序设置的目标尺寸与本次 resize 一致 → 是程序改的，不记录
      const program = programSizes[currentWindowType];
      if( program && Math.abs(program[0] - newSize[0]) <= 3 && Math.abs(program[1] - newSize[1]) <= 3 ) {
        return;
      }
      const currentSize = utils.config.get(currentWindowType);
      if( (currentSize[0] != newSize[0]) || (currentSize[1] != newSize[1]) ) {
        utils.config.set(currentWindowType, newSize);
      }
    }, 600);
  });
}

// 根据用户访问的url决定app窗口尺寸
// 初值不是 'default' 而是 'windowSizeDefault'，与 getWindowTypeByUrl 的返回保持一致，
// 避免启动时被误判为「类型变了」而白跑一次 setBounds
var currentWindowType = 'windowSizeDefault';

// 按地址判断目标窗口类型（抽出来是为了在路由阶段就能提前切窗口，避免先按旧尺寸渲染再缩小造成闪烁）
function getWindowTypeByUrl(url) {
  if( url.indexOf('/video/') > -1 || url.indexOf('html5player.html') > -1 ||
    /\/\/live\.bilibili\.com\/blanc\/\d+/.test(url) || url.indexOf('bangumi/play/') > -1 ) {
    return 'windowSizeMini';
  } else if( url.indexOf('t.bilibili.com/?tab=8') > -1 ) {
    return 'windowSizeFeed';
  } else if( (url.indexOf('space.bilibili.com') > -1 && url.indexOf('/channel/') > -1) ||
             url.indexOf('bilibili.com/list/') > -1 ||
             url.indexOf('bilibili.com/medialist/') > -1 ) {
    // 合集/收藏列表是桌面版页面，窗口太小会看不全，使用专门的尺寸
    // 注意 favlist 不在此列：它已改为跳转移动端空间页在页内渲染，窗口保持默认大小
    return 'windowSizeSpace';
  } else {
    return 'windowSizeDefault';
  }
}

function applyWindowType(targetWindowType) {
  if( targetWindowType == currentWindowType ) {
    return;
  }
  let mw = remote.getCurrentWindow(),
    currentSize = mw.getSize(),
    leftTopPosition = mw.getPosition(),
    rightBottomPosition = [leftTopPosition[0] + currentSize[0], leftTopPosition[1] + currentSize[1]],
    targetSize = utils.config.get(targetWindowType),
    targetPosition = [rightBottomPosition[0] - targetSize[0], rightBottomPosition[1] - targetSize[1]];

  // 原先只考虑了一块屏幕的情况，其实有副屏时x轴是有可能为负数的
  // 所以我们取一个简单的方法，只有一块屏幕时鼠标最小坐标是0，窗口不可能被拖到x<-width的位置上。所以如果这个窗口的x小于-width，那一定是被拖到副屏上了
  // 只有在他的x处于[-width, 10]之间时，此时窗口应该横跨在左右两块屏幕的交界上，这时我们强行把窗口挪到主屏的x=10位置
  if (targetPosition[0] > -targetSize[0] && targetPosition[0] < 10) {
    targetPosition[0] = 10;
  }
  targetPosition[1] = targetPosition[1] > 10 ? targetPosition[1] : 10;

  // 窗口尺寸统一交给主进程设置
  // 渲染进程直接调 remote.setBounds 在部分环境（Windows + 高DPI/无边框窗口）会静默失败
  // 登记程序设置的目标尺寸，resize 事件到达时据此跳过记录（见 saveWindowSizeOnResize）
  programSizes[targetWindowType] = [targetSize[0], targetSize[1]];
  ipc.send('resize-main-window', {
    x: targetPosition[0],
    y: targetPosition[1],
    width: targetSize[0],
    height: targetSize[1]
  });

  currentWindowType = targetWindowType;
  utils.log(`窗口：切换为 ${targetWindowType} → ${targetSize[0]}x${targetSize[1]} @ ${targetPosition[0]},${targetPosition[1]}`);

  // 通知子窗口跟随移动
  ipc.send('main-window-resized', targetPosition, targetSize);
}

function resizeMainWindow() {
  const url = wv.getURL();
  const t = getWindowTypeByUrl(url);
  utils.log(`窗口：did-finish-load 后重新计算，url=${url} → ${t}（当前=${currentWindowType}）`);
  applyWindowType(t);
}

// 是否是会自动进入网页全屏的播放页（这些页面由 inject.js 自己控制遮罩的收尾时机）
function isPlayerUrl(url) {
  return url.indexOf('/video/') > -1 || url.indexOf('html5player.html') > -1 ||
         url.indexOf('bangumi/play/') > -1 || /\/\/live\.bilibili\.com\/blanc\/\d+/.test(url);
}

// 根据视频是横版还是竖版，把窗口摆成对应形状
// 横版视频 → 横向窗口；竖版视频 → 竖向窗口
// 两种不能混淆：否则横版视频进竖窗口会上下大黑边，竖版视频进横窗口会左右大黑边
// currentVideoShape 记录当前视频形状，lastFitSize 记录上次适配尺寸，避免重复调整
var currentVideoShape = null;
var lastFitSize = null;
let videoFitTimer = null;
function fitWindowToVideoShape(videoW, videoH) {
  if( !videoW || !videoH ) return;
  const ratio = videoW / videoH;
  const isVertical = ratio < 1;
  const mw = remote.getCurrentWindow();
  const currentSize = mw.getSize();

  // 以屏幕可用区域的短边为基准，避免窗口超出屏幕
  const workArea = remote.screen.getPrimaryDisplay().workAreaSize;
  const maxH = Math.round(workArea.height * 0.85);
  const maxW = Math.round(workArea.width * 0.85);

  let width, height;
  if( isVertical ) {
    // 竖版：高度取屏幕的 85%（最多），宽度按视频比例反推
    height = maxH;
    width = Math.round(height * ratio);
    if( width > maxW ) {
      width = maxW;
      height = Math.round(width / ratio);
    }
  } else {
    // 横版：宽度沿用当前主窗口宽度（用户习惯的宽度），高度按比例反推
    width = Math.min(currentSize[0], maxW);
    height = Math.round(width / ratio);
    if( height > maxH ) {
      height = maxH;
      width = Math.round(height * ratio);
    }
  }

  width = Math.max(160, width);
  height = Math.max(120, height);

  // 同一形状下不重复调整，避免用户手动拖动窗口后被强行改回去
  const shapeKey = isVertical ? 'vertical' : 'horizontal';
  if( currentVideoShape === shapeKey && currentSize[0] == width && currentSize[1] == height ) {
    return;
  }
  if( currentVideoShape === shapeKey && lastFitSize &&
      currentSize[0] == lastFitSize[0] && currentSize[1] == lastFitSize[1] ) {
    return;
  }

  // 保持窗口右下角不动
  const pos = mw.getPosition();
  const targetPosition = [
    Math.max(10, pos[0] + currentSize[0] - width),
    Math.max(10, pos[1] + currentSize[1] - height)
  ];

  clearTimeout(videoFitTimer);
  videoFitTimer = setTimeout(() => {
    // 登记程序设置的目标尺寸，避免这次程序改尺寸被当成用户拖动存进 windowSizeMini
    programSizes[currentWindowType] = [width, height];
    ipc.send('resize-main-window', {
      x: targetPosition[0],
      y: targetPosition[1],
      width: width,
      height: height
    });
    currentVideoShape = shapeKey;
    lastFitSize = [width, height];
    utils.log(`视频形状适配：${isVertical ? '竖版' : '横版'} ${videoW}x${videoH}（比例 ${ratio.toFixed(2)}）→ 窗口 ${width}x${height}`);
    // 改窗口尺寸会让 B 站播放器重排并退出网页全屏，稍等布局稳定后让注入脚本重新确认一次全屏
    setTimeout(() => {
      if( isPlayerUrl(wv.getURL()) ) {
        wv.send('recheck-webscreen');
      }
    }, 600);
  }, 200);
}

// 记录当前视频形状和最近一次适配的尺寸，用来避免重复调整

// 播放页把播放器切到网页全屏后通知过来，这时才撤掉遮罩，避免看到中间布局
// webview 里的 preload 用 ipcRenderer.sendToHost 发消息，宿主页面要通过 ipc-message 事件接收
function initActionOnPlayerReady() {
  wv.addEventListener('ipc-message', (e) => {
    if( e.channel === 'player-webscreen-ready' ) {
      utils.log('播放器已进入网页全屏，撤掉loading遮罩');
      wrapper.classList.remove('loading');
    } else if( e.channel === 'home-refreshed' ) {
      utils.log('首页推荐已刷新');
      wrapper.classList.remove('loading');
    } else if( e.channel === 'speed-changed' ) {
      // 用户在 B 站播放器自带的倍速菜单里改了速度，同步更新顶栏按钮显示
      const rate = e.args && e.args[0];
      if( typeof rate === 'number' && rate > 0 && !v.disableSpeedButton ) {
        v.currentSpeed = rate;
        utils.log(`倍速：B站播放器侧改为 ${v.fmtSpeed(rate)}`);
      }
    } else if( e.channel === 'video-ratio' ) {
      const info = e.args && e.args[0];
      if( info ) {
        fitWindowToVideoShape(info.width, info.height);
      }
    }
  });
}

// webview跳转相关
function initActionOnWebviewNavigate() {
  let _lastVid = 0;
  // 判断是否能前进/后退
  wv.addEventListener('did-finish-load', function() {
    let url = wv.getURL();
    utils.log(`触发 did-finish-load 事件，当前url是: ${url}`);
    v.naviCanGoBack = _history.canGoBack();
    v.naviCanGoForward = _history.canGoForward();
    // 把当前webview的实际url记录下来
    _history.lastLoadedUrl = url;
    // 改变窗口尺寸
    resizeMainWindow();
    // 关闭loading遮罩
    // 播放页的注入脚本会先把页面遮住、等网页全屏就位后才发 player-webscreen-ready 过来，
    // 这里如果直接撤掉遮罩，中间会露出一次普通布局，所以播放页交给那个信号来收尾
    if( !isPlayerUrl(url) ) {
      wrapper.classList.remove('loading');
    }
    // 从别的页面点刷新时，回首页后还要再换一批推荐，这里补上
    if( _history.pendingRefreshHome && /^https:\/\/m\.bilibili\.com\//.test(url) ) {
      _history.pendingRefreshHome = false;
      wrapper.classList.add('loading');
      wv.send('refresh-home');
    }
    // 根据url格式判断是获取普通分p还是番剧分p
    const vid = utils.getVid(url);
    if( vid ) {
      // 现在存在同一个视频自动跳下一p的可能，这时也会触发路由重新加载页面，但是这时不应该重新获取分p数据
      if (vid !== _lastVid) {
        // 换了视频，清掉形状记录，让新视频重新做横/竖适配
        currentVideoShape = null;
        lastFitSize = null;
        getPartOfVideo(vid);
        _lastVid = vid;
      }
    } else if( url.indexOf('bangumi/play/') > -1 ) {
      getPartOfBangumi(url);
    } else {
      // 离开播放页，重置形状记录
      currentVideoShape = null;
      lastFitSize = null;
    }
    // 倍速按钮只在视频/番剧页可用；不跨视频记忆，每个视频都重置为 1.0
    // （同时覆盖 B 站播放器自己的倍速记忆，保证「换视频就要重选」）
    const speedPageOk = url.indexOf('/video/') > -1 || url.indexOf('bangumi/play/') > -1;
    v.disableSpeedButton = !speedPageOk;
    v.speedMenuShow = false;
    v.currentSpeed = 1;
    if( speedPageOk ) {
      wv.send('set-speed', 1);
    }
    ipc.send('url-changed', url);
  });
  wv.addEventListener('will-navigate', function(e) {
    if( e.url.startsWith('bilibili://') ) {
      utils.log(`网页端尝试拉起App: ${e.url}`);
      e.preventDefault();
      return false;
    } else {
      utils.log(`触发 will-navigate 事件，目标: ${e.url}`);
      _history.go(e.url);
    }
  });
  // b站mobile版看起来是改用pushstate做单页应用了，没法从webview上监听到will-navigate事件了
  // 只能祭出古老的dirty check了
  setInterval(function() {
    // 程序自己刚发起过跳转时，webview 的 getURL 还要过一会儿才更新，
    // 这段时间里读到的是旧地址，会被误判成「用户点了新页面」而把跳转抢回原页面
    if( Date.now() < _history.ignoreUntil ) {
      return;
    }
    const nowUrl = wv.getURL();
    // 用新url和history堆栈的最后一个记录作对比，如果不同就说明webview里加载了新页面
    // lastLoadedUrl是为了防止在后退操作时，_history中的堆栈已经改变了，但是webview因为还没有加载完成，被dirtycheck检测到url和_history
    // 的最后一条数据对不上，而再次调用_history.go方法造成无法后退的情况
    // 比较时统一走 normalizeUrl，否则 B 站自己加的 vd_source 等统计参数会让两边永远不相等，
    // 造成每 500ms 触发一次无意义的跳转，页面反复重载
    if( normalizeUrl(nowUrl) != normalizeUrl(_history.stack[_history.pos]) &&
        normalizeUrl(nowUrl) != normalizeUrl(_history.lastLoadedUrl) ) {
      utils.log(`Dirty-check检测到Webview的url改变，目标: ${nowUrl}`);
      _history.go(nowUrl);
    }
  }, 500);
  // webview中点击target="_blank"的链接时在当前webview打开
  wv.addEventListener('new-window', function(e) {
    // bilibili:// 是唤起手机 App 的协议，桌面端没有对应程序，
    // 放行会让 Windows 弹出「获取打开此 bilibili 链接的应用」对话框，所以直接拦掉
    if( !/^https?:/i.test(e.url) ) {
      utils.log(`new-window 拦截非http链接: ${e.url}`);
      e.preventDefault();
      return false;
    }
    utils.log(`触发 new-window 事件，目标: ${e.url}`);
    _history.go(e.url);
  });
}

// 点击菜单「webview console」时打开webview
function openWebviewConsoleOnMenuClick() {
  ipc.on('openWebviewDevTools', () => {
    wv.openDevTools();
  });
}

// 收到选p消息时跳p
function redirectOnSelectPart() {
  ipc.on('select-part', (ev, pid) => {
    _history.goPart(pid);
  });
  ipc.on('select-bangumi-part', (ev, ep) => {
    _history.goBangumiPart(ep);
  });
}

// 按下ESC键
function initActionOnEsc() {
  ipc.on('press-esc', (ev) => {
    let url = wv.getURL();
    // 如果在播放页按下esc就触发后退
    if( utils.getVidWithP(url) || url.indexOf('bangumi/play') > -1 ) {
      utils.log('在播放器页面按下ESC，后退至上一页');
      _history.goBack();
    }
  });
}

// 用户按↑、↓键时，把事件传递到webview里去实现修改音量功能
function initWebviewVolumeContrlShortcuts() {
  ipc.on('change-volume', (ev, arg) => {
    wv.send('change-volume', arg);
  });
}

// 用户按老板键触发隐藏时自动停止播放视频
function initActionOnBossButtonPressed() {
  ipc.on('hide-hide-hide', () => {
    if (utils.config.get('autoPause')) {
      wv.send('hide-hide-hide');
    }
  });
}

// windows下frameless window没法正确检测到mouseout事件，只能根据光标位置做个dirtyCheck了
function initMouseStateDirtyCheck() {
  // 统一改为由js判断，一旦鼠标进入主窗口的上较近才显示topbar
  var getMousePosition = remote.screen.getCursorScreenPoint,
    mw = remote.getCurrentWindow(), 
    lastStatus = 'OUT';
  setInterval(function() {
    let mousePos = getMousePosition(),
      windowPos = mw.getPosition(),
      windowSize = mw.getSize();
    // 在窗口最右边留出滚动条的宽度，用户操作滚动条时不会触发showTopbar；
    // 但是如果showTopbar已经触发，即用户已经在操作工具栏了，那么就暂时屏蔽这个规则
    function getTriggerAreaWidth() {
      return lastStatus == 'IN' ? 0 : 16;
    }
    // 如果topbar已经下来了，就主动把触发区域变高一点，防止鼠标稍微向下滑动就触发收起
    function getTriggerAreaHeight() {
      let h = 0.1 * windowSize[1],
          minHeight = lastStatus == 'IN' ? 120 : 36; 
      return h > minHeight ? h : minHeight;
    }
    if( (mousePos.x > windowPos[0]) && (mousePos.x < windowPos[0] + windowSize[0] - getTriggerAreaWidth()) &&
        (mousePos.y > windowPos[1]) && (mousePos.y < windowPos[1] + getTriggerAreaHeight()) ) {
      if( lastStatus == 'OUT' ) {
        wrapper.classList.add('showTopBar');
        lastStatus = 'IN';
      }
    } else if( lastStatus == 'IN' ) {
      lastStatus = 'OUT';
      wrapper.classList.remove('showTopBar');
    }
  }, 200);
}

// 外链
function openExternalLink(url) {
  shell.openExternal(url);
}

// 把webview里的报错信息log下来
function logWebviewError() {
  wv.addEventListener('console-message', (err) => {
    // 目测 0 = verbose 1 = info 2 = warning 3 = error
    if(err.level > 2) {
      utils.error(`Webview报错\nLine ${err.line}: ${err.message}\nwebview当前url: ${wv.getURL()}`)
    }
  });
}

// 每次进入首页都换一批推荐
// 首页推荐是服务端直出、对同一用户固定返回的，不主动换的话每次打开（或从视频页返回）
// 看到的都是同一批视频，所以只要落到首页就通知注入脚本用 fresh_idx 拉一次新数据
function initHomeRefreshOnLaunch() {
  // 用「上一次停留的页面」判断是否刚回到首页，而不是靠 will-navigate 清标记：
  // B 站首页和视频页之间是 SPA 跳转，不会触发 will-navigate，标记会一直残留
  let lastPageUrl = '';
  let retryTimer = null;

  const isHome = (url) => /^https:\/\/m\.bilibili\.com\/(index\.html)?(\?.*)?$/.test(url);

  // 注入脚本注册监听需要时间，did-finish-load 时页面脚本不一定已经跑完，
  // 所以发出后要回读页面上第一个视频卡片，确认列表真的换了；没换就重试
  const sendRefresh = (attempt) => {
    utils.log(`首页：换一批推荐（第 ${attempt} 次）`);
    wv.send('refresh-home');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(async () => {
      try {
        const firstHref = await wv.executeJavaScript(
          `(function(){var a=document.querySelector('a.v-card');return a?a.getAttribute('href'):null})()`
        );
        // 第一张卡还是空可能说明注入脚本尚未就绪，重试；最多 3 次
        if( !firstHref && attempt < 3 ) {
          sendRefresh(attempt + 1);
        }
      } catch(e) {
        if( attempt < 3 ) {
          sendRefresh(attempt + 1);
        }
      }
    }, 2500);
  };

  const tryRefresh = () => {
    const url = wv.getURL();
    if( !url ) return;
    // 只有「这一次是首页、上一次不是首页」才算刚回到首页，避免在首页停留时反复刷新
    const justCameHome = isHome(url) && !isHome(lastPageUrl);
    lastPageUrl = url;
    if( !justCameHome ) {
      return;
    }
    sendRefresh(1);
  };

  // 整页加载完成时检查一次（启动进入首页会走这里）
  wv.addEventListener('did-finish-load', () => {
    setTimeout(tryRefresh, 800);
  });
  // B 站是 SPA，视频页返回首页不一定触发 did-finish-load，所以再用定时轮询兜底
  setInterval(tryRefresh, 800);
}

window.addEventListener('DOMContentLoaded', function() {
  wrapper = document.getElementById('wrapper');
  wv = document.getElementById('wv');
  detectPlatform();
  checkUpdateOnInit();
  initActionOnWebviewNavigate();
  initActionOnEsc();
  initActionOnPlayerReady();
  initActionOnBossButtonPressed();
  initWebviewVolumeContrlShortcuts();
  saveWindowSizeOnResize();
  initMouseStateDirtyCheck();
  openWebviewConsoleOnMenuClick();
  redirectOnSelectPart();
  logWebviewError();
  initHomeRefreshOnLaunch();
});

window.onerror = function(err, f, line) {
  var id = f.split('/');
  utils.error(`${id[id.length-1]} : Line ${line}\n> ${err}`);
}
