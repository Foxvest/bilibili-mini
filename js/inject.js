const ipc = require('electron').ipcRenderer;

window.addEventListener('DOMContentLoaded', function() {
  // 普通视频页：自动最大化播放器
  if( window.location.href.indexOf('video/av') > -1 || 
      window.location.href.indexOf('video/BV') > -1 ||
      window.location.href.indexOf('html5player.html') > -1 ||
      window.location.href.indexOf('bangumi/play/') > -1 ) {
    // 进入网页全屏前先把页面遮住（黑底），等全屏布局就位后再显示。
    // 否则用户会先看到普通布局的播放页，再突然跳成全屏，视觉上就是闪一下
    const hideStyle = document.createElement('style');
    hideStyle.textContent = 'html.bilimini-player-pending{background:#000 !important;}' +
                            'html.bilimini-player-pending body{opacity:0 !important;}';
    document.head.appendChild(hideStyle);
    document.documentElement.classList.add('bilimini-player-pending');

    // 读取视频真实宽高比并上报；metadata 还没加载好时等 loadedmetadata
    // 定义在 revealPlayer 之前，避免 const 的暂时性死区问题
    let ratioReported = false;
    const reportVideoRatio = () => {
      if( ratioReported ) return;
      const video = document.querySelector('video');
      if( !video ) {
        setTimeout(reportVideoRatio, 200);
        return;
      }
      const send = () => {
        if( ratioReported ) return;
        if( !video.videoWidth || !video.videoHeight ) return;
        ratioReported = true;
        ipc.sendToHost('video-ratio', {
          width: video.videoWidth,
          height: video.videoHeight
        });
      };
      if( video.readyState >= 1 && video.videoWidth ) {
        send();
      } else {
        video.addEventListener('loadedmetadata', send, { once: true });
        setTimeout(send, 1500);
      }
    };

    let playerRevealed = false;
    const revealPlayer = () => {
      if( playerRevealed ) return;
      playerRevealed = true;
      clearTimeout(revealTimeout);
      document.documentElement.classList.remove('bilimini-player-pending');
      // 把视频画面比例报给宿主，用来决定窗口该用横版还是竖版
      reportVideoRatio();
      // 通知宿主窗口（index.js）撤掉 loading 遮罩
      // webview 里必须用 sendToHost，普通的 ipc.send 是发给主进程的，宿主页面收不到
      ipc.sendToHost('player-webscreen-ready');
    };
    // 兜底：广告页、加载失败等情况下播放器可能起不来，别让页面一直黑着
    const revealTimeout = setTimeout(revealPlayer, 4500);

    let playerInitCheck = setInterval(() => {
      let wideScreenButton;
      // 新版播放器（bpx）的网页全屏按钮是 bpx-player-ctrl-web
      // 旧版播放器则是 bilibili-player-iconfont-web-fullscreen / squirtle-video-pagefullscreen
      if( wideScreenButton = document.querySelector(
        '[class*="bpx-player-ctrl-web"],[class*="bilibili-player-iconfont-web-fullscreen"],[class*="squirtle-video-pagefullscreen"]'
      ) ) {
        // 如果播放器已经处于网页全屏状态，就不要重复点击把它退出了
        if( !wideScreenButton.classList.contains('bpx-state-entered') &&
            !document.body.classList.contains('webscreen-fix') ) {
          wideScreenButton.click();
        }
        // 隐藏全屏播放器（在某些情况下会出现）的滚动条
        document.body.style.overflow = 'hidden';
        // 用户拖动窗口改变大小时，让播放器重新计算一次布局，
        // 否则视频可能保持旧尺寸、周围留出空白
        let resizeTimer;
        window.addEventListener('resize', () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            // 播放器内部有自己监听 resize，浏览器本身已经派发过一次；
            // 这里补一次对容器高度的重新赋值，强制按新窗口尺寸重排
            const player = document.querySelector('.bpx-player-container');
            if( player ) {
              player.style.height = player.style.height;
            }
            // 拖窗口也可能让播放器退出网页全屏，退出了就点回来
            const btn = document.querySelector(
              '[class*="bpx-player-ctrl-web"],[class*="bilibili-player-iconfont-web-fullscreen"],[class*="squirtle-video-pagefullscreen"]'
            );
            if( btn ) {
              const stillOn = btn.classList.contains('bpx-state-entered') ||
                              document.body.classList.contains('webscreen-fix');
              if( !stillOn ) {
                btn.click();
                document.body.style.overflow = 'hidden';
              }
            }
          }, 250);
        });
        // 等全屏布局生效后再把页面显示出来，避免看到中间态
        setTimeout(revealPlayer, 120);
        // 从app层面把 上、下 按键传进来，方便播放器控制音量
        ipc.on('change-volume', (ev, arg) => {
          let event = new KeyboardEvent('keydown', {
            bubbles: true
          });
          // 傻逼玩意儿which和keycode因为deprecated变成只读了，替代的属性又还没通用，搞条毛？
          Object.defineProperties(event, {
            keyCode: { writeable: true, value: arg == 'up' ? 38 : 40 }
          });
          // 新版播放器的音量按钮是 bpx-player-ctrl-volume，旧版是 bilibili-player-iconfont-volume-max
          let volume = document.querySelector('.bilibili-player-iconfont-volume-max') ||
                       document.querySelector('.bpx-player-ctrl-volume');
          volume && volume.dispatchEvent(event);
        });
        // 用户按了老板键，停止播放视频
        ipc.on('hide-hide-hide', () => {
          const video = document.querySelector('video');
          // 只有当视频处在播放状态时才暂停，如果本来就暂停了就别动了
          if (video && !video.paused) {
            video.pause();
          }
        });
        // 宿主改了窗口尺寸后，B 站播放器可能重排并退出网页全屏，
        // 这里收到通知就检查一次，退出了就重新点回来
        ipc.on('recheck-webscreen', () => {
          const btn = document.querySelector(
            '[class*="bpx-player-ctrl-web"],[class*="bilibili-player-iconfont-web-fullscreen"],[class*="squirtle-video-pagefullscreen"]'
          );
          if( !btn ) return;
          const stillOn = btn.classList.contains('bpx-state-entered') ||
                          document.body.classList.contains('webscreen-fix');
          if( !stillOn ) {
            btn.click();
            document.body.style.overflow = 'hidden';
          }
        });
        clearInterval(playerInitCheck);
      } else if( ++checkCount > 200 ) {
        clearInterval(playerInitCheck);
      }
    }, 50), checkCount = 0;
  }

  // 番剧页：获取播放器iframe地址并转跳
  else if( /anime\/\d+\/play/.test(window.location.href) ) {
    var playerInitCheck = setInterval(() => {
      let ifr;
      if( ifr = document.querySelector('iframe') ) {
        if( ifr.src.indexOf('iframemessage.html') == -1 ) {
          window.location.href = ifr.src;
          clearInterval(playerInitCheck);
        }
      } else if( ++checkCount > 400 ) {
        clearInterval(playerInitCheck);
      }
    }, 50), checkCount = 0;
  }

  // 个人空间页：移动版只有「动态 / 视频」两个 tab，收藏夹没有入口
  // 这里补一个「收藏」tab，并在当前页面内渲染收藏内容
  // 不跳转桌面版 space.bilibili.com/favlist，否则窗口会被撑大、排版也和主页不一致
  else if( /\/\/m\.bilibili\.com\/space\/(\d+)/.test(window.location.href) ) {
    const uid = /\/\/m\.bilibili\.com\/space\/(\d+)/.exec(window.location.href)[1];
    let spaceInitCount = 0;
    const spaceInitCheck = setInterval(() => {
      const tabs = document.querySelector('.m-space .tabs');
      const videoItem = document.querySelector('.video-item-space');
      // tab 栏和视频项都要就位，克隆视频项才能保证排版和主页「视频」列表完全一致
      if( !tabs || !videoItem ) {
        if( ++spaceInitCount > 200 ) {
          clearInterval(spaceInitCheck);
        }
        return;
      }
      clearInterval(spaceInitCheck);
      if( tabs.querySelector('.bilimini-fav-tab') ) {
        return;
      }
      // 记录原始 tab 和列表，离开收藏 tab 时用于还原
      const originalItems = [...tabs.querySelectorAll('span')];
      const listNode = document.querySelector('.m-space .list');
      const listBackup = listNode.innerHTML;
      let favTabOn = false;

      // B 站的白色背景等样式挂在使用 scoped 属性的选择器上（如 .archive-list[data-v-0bc25d57]），
      // 手动 createElement 出来的元素没有这些属性，样式就不生效（表现为背景透明、看字不清）。
      // 这里记录原生 .archive-list 上的 data-v-* 属性，创建新容器时照抄过去
      const nativeArchive = document.querySelector('.m-space .list .archive-list');
      const scopedAttrs = nativeArchive
        ? [...nativeArchive.attributes].filter(a => /^data-v-/.test(a.name)).map(a => a.name)
        : [];
      // 创建一个带 scoped 属性、样式与原生一致的列表容器
      const createArchiveList = () => {
        const el = document.createElement('div');
        el.className = 'archive-list';
        scopedAttrs.forEach(name => el.setAttribute(name, ''));
        return el;
      };

      const tab = document.createElement('span');
      tab.className = 'bilimini-fav-tab';
      tab.textContent = '收藏';
      // 沿用动态/视频 tab 的实际排版（inline-block + 右外边距）
      const ref = originalItems[0];
      const cs = getComputedStyle(ref);
      tab.style.cssText = `display:inline-block;font-size:${cs.fontSize};line-height:${cs.lineHeight};` +
                          `color:${cs.color};margin:${cs.margin};cursor:pointer;`;
      tabs.appendChild(tab);

      // 把收藏 tab 切为选中态，同时取消动态/视频的选中态
      // 记录原始的选中项，还原时用
      const originalOn = originalItems.filter(s => s.classList.contains('on'));
      const activeColor = originalOn.length ? getComputedStyle(originalOn[0]).color : cs.color;
      const setOn = (on) => {
        if( on ) {
          originalItems.forEach(s => s.classList.remove('on'));
          tab.classList.add('on');
          tab.style.color = activeColor;
        } else {
          tab.classList.remove('on');
          tab.style.color = cs.color;
        }
      };

      // 时长格式：不足 1 小时显示 mm:ss，超过 1 小时显示 h:mm:ss
      const fmtDuration = (s) => {
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        const pad = n => (n < 10 ? '0' : '') + n;
        return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
      };
      const fmtCount = (n) => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);

      // 替换克隆节点的封面。封面在 <picture> 里，source[srcset] 优先级高于 img[src]，两个都要换
      const setCover = (node, url) => {
        const cover = (url || '').replace(/^http:/, 'https:');
        const picture = node.querySelector('.cover picture');
        if( !picture ) return;
        picture.querySelectorAll('source').forEach(src => src.setAttribute('srcset', cover));
        const img = picture.querySelector('img');
        if( img ) {
          img.src = cover;
          img.removeAttribute('data-onload');
          img.removeAttribute('data-onerror');
        }
      };
      const setTitle = (node, text) => {
        const title = node.querySelector('.title');
        if( title ) title.textContent = text;
      };
      const setPlayCount = (node, count) => {
        const view = node.querySelector('.state .view');
        if( !view ) return;
        const icon = view.querySelector('svg');
        view.innerHTML = '';
        if( icon ) view.appendChild(icon);
        view.appendChild(document.createTextNode(' ' + fmtCount(count)));
      };

      // 用收藏夹数据克隆「视频」列表项的 DOM，保证和主页排版一致
      const renderFavList = (medias) => {
        const wrapper = createArchiveList();
        medias.forEach(media => {
          const node = videoItem.cloneNode(true);
          const videoHref = `https://m.bilibili.com/video/${media.bvid}`;
          node.setAttribute('universallink', videoHref);
          // 关键：必须移除 schema 属性。它是 bilibili:// 唤起协议，
          // m-open-app 组件的 shadow DOM 会读它去拉起 App，
          // 桌面端没有对应程序，会弹出 Windows 的「获取打开此链接的应用」对话框
          node.removeAttribute('schema');
          // m-open-app 是带 shadow DOM 的自定义元素，点击行为依赖其内部实现，
          // 克隆出来的节点不会自动响应，所以这里自己接管点击跳转
          node.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.location.href = videoHref;
          }, true);
          setCover(node, media.cover);
          const duration = node.querySelector('.duration');
          if( duration ) duration.textContent = fmtDuration(media.duration);
          setTitle(node, media.title);
          if( media.cnt_info ) setPlayCount(node, media.cnt_info.play);
          wrapper.appendChild(node);
        });
        return wrapper;
      };

      // 收藏夹列表：同样复用视频项的 DOM，封面用该收藏夹第一个视频的封面，
      // 标题位上显示收藏夹名称，播放量位上显示视频数
      const renderFolderList = (folders) => {
        const wrapper = createArchiveList();
        folders.forEach(folder => {
          const node = videoItem.cloneNode(true);
          node.classList.add('bilimini-fav-folder');
          setCover(node, folder.cover);
          // 收藏夹没有时长，把时长角标藏掉
          const duration = node.querySelector('.duration');
          if( duration ) duration.style.display = 'none';
          setTitle(node, folder.title);
          // 播放量图标换成「视频数」更直观，这里直接写文字
          const view = node.querySelector('.state .view');
          if( view ) {
            const icon = view.querySelector('svg');
            view.innerHTML = '';
            if( icon ) view.appendChild(icon);
            view.appendChild(document.createTextNode(' ' + folder.media_count + ' 个视频'));
          }
          node.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openFolder(folder);
          }, true);
          wrapper.appendChild(node);
        });
        return wrapper;
      };

      // 收藏夹内的二级视图顶部，加一个「返回收藏夹」的面包屑
      const renderFolderHeader = (folder) => {
        const header = document.createElement('div');
        // 同时带 archive-list 类，直接复用页面对该类的白底样式，
        // 保证和下面的列表同色、并随窗口透明度一起变化
        header.className = 'bilimini-fav-header archive-list';
        scopedAttrs.forEach(name => header.setAttribute(name, ''));
        header.style.cssText = 'display:flex;align-items:center;padding:10px 12px;font-size:13px;color:#757575;';
        const back = document.createElement('span');
        back.className = 'bilimini-fav-back';
        back.textContent = '‹ 收藏夹';
        back.style.cssText = 'cursor:pointer;color:#fb7299;margin-right:8px;';
        back.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showFolders();
        });
        const name = document.createElement('span');
        name.className = 'bilimini-fav-folder-name';
        name.textContent = folder.title;
        name.style.cssText = 'color:#212121;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const count = document.createElement('span');
        count.textContent = `${folder.media_count} 个视频`;
        count.style.cssText = 'margin-left:auto;flex-shrink:0;';
        header.appendChild(back);
        header.appendChild(name);
        header.appendChild(count);
        return header;
      };

      const setLoading = (text) => {
        listNode.innerHTML = `<div class="bilimini-fav-loading" style="padding:24px 12px;text-align:center;color:#999;font-size:13px;">${text}</div>`;
      };

      // 二级视图：某个收藏夹里的视频
      const openFolder = async (folder) => {
        setLoading('加载中…');
        try {
          const res = await fetch(
            `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${folder.id}&pn=1&ps=20&platform=web`,
            { credentials: 'include' }
          ).then(r => r.json());
          const medias = (res.data && res.data.medias) || [];
          listNode.innerHTML = '';
          listNode.appendChild(renderFolderHeader(folder));
          if( !medias.length ) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:24px 12px;text-align:center;color:#999;font-size:13px;';
            empty.textContent = '这个收藏夹还是空的';
            listNode.appendChild(empty);
            return;
          }
          listNode.appendChild(renderFavList(medias));
        } catch(err) {
          setLoading('收藏夹加载失败');
        }
      };

      // 一级视图：收藏夹列表
      const showFolders = async () => {
        setLoading('加载中…');
        try {
          const res = await fetch(
            `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${uid}`,
            { credentials: 'include' }
          ).then(r => r.json());
          const folders = (res.data && res.data.list) || [];
          if( !folders.length ) {
            setLoading('没有找到收藏夹');
            return;
          }
          // 收藏夹本身没有封面字段，取每个收藏夹第一条视频的封面，并发请求
          const withCovers = await Promise.all(folders.map(async folder => {
            try {
              const m = await fetch(
                `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${folder.id}&pn=1&ps=1&platform=web`,
                { credentials: 'include' }
              ).then(r => r.json());
              const first = m.data && m.data.medias && m.data.medias[0];
              return Object.assign({}, folder, { cover: first ? first.cover : '' });
            } catch(e) {
              return Object.assign({}, folder, { cover: '' });
            }
          }));
          listNode.innerHTML = '';
          listNode.appendChild(renderFolderList(withCovers));
        } catch(err) {
          setLoading('收藏夹加载失败');
        }
      };

      const showFav = () => {
        // 每次点收藏 tab 都回到收藏夹列表（一级视图）
        if( !favTabOn ) {
          favTabOn = true;
          setOn(true);
        }
        showFolders();
      };

      const hideFav = () => {
        if( !favTabOn ) return;
        favTabOn = false;
        setOn(false);
        // 恢复原来选中项的高亮
        originalOn.forEach(s => s.classList.add('on'));
        listNode.innerHTML = listBackup;
      };

      tab.addEventListener('click', showFav);
      // 点回原来的「动态 / 视频」时还原列表
      originalItems.forEach(item => item.addEventListener('click', hideFav));
    }, 100);
  }

  // 首页：支持「刷新主页」换一批推荐
  // B 站移动版首页的推荐是服务端直出且对同一用户固定返回的，单纯 reload 拿不到新内容，
  // 只有带递增 fresh_idx 的推荐接口才会每次返回不同的视频，所以这里直接用接口数据替换列表
  else if( window.location.pathname == '/' || /\/index\.html$/.test(window.location.pathname) ) {
    const RECOMMEND_API = 'https://api.bilibili.com/x/web-interface/index/top/feed/rcmd';
    let freshIdx = 1;
    let refreshing = false;

    const fmtCount = (n) => n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
    const fmtDuration = (s) => {
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
      const pad = n => (n < 10 ? '0' : '') + n;
      return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
    };

    // 用接口数据重填首页卡片，DOM 结构完全克隆现有卡片以保证样式一致
    // 首页结构是 .video-list > .card-box > a.v-card × N，所以卡片模板取 a.v-card，
    // 生成的新卡片仍然放回同一个 .card-box 里
    const applyRecommend = (items) => {
      const list = document.querySelector('.m-home .video-list') ||
                   document.querySelector('.video-list');
      if( !list ) return false;
      const cardBox = list.querySelector('.card-box');
      const cardTemplate = list.querySelector('a.v-card');
      if( !cardBox || !cardTemplate ) return false;
      const fragment = document.createDocumentFragment();
      items.forEach(item => {
        if( !item.bvid ) return;
        const node = cardTemplate.cloneNode(true);
        const href = `https://m.bilibili.com/video/${item.bvid}`;
        node.setAttribute('href', `/video/${item.bvid}`);
        // 克隆出来的节点点击行为不一定还绑在 Vue 上，这里自己接管跳转
        node.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.location.href = href;
        }, true);
        // 封面：picture 的 source[srcset] 优先级高于 img[src]，两个都要换
        const picture = node.querySelector('picture');
        if( picture ) {
          const cover = (item.pic || '').replace(/^http:/, 'https:');
          picture.querySelectorAll('source').forEach(src => src.setAttribute('srcset', cover));
          const img = picture.querySelector('img');
          if( img ) {
            img.src = cover;
            img.alt = item.title || '';
            img.removeAttribute('onload');
            img.removeAttribute('onerror');
          }
        }
        const title = node.querySelector('.v-card__title, h3, .title');
        if( title ) title.textContent = item.title || '';
        // 播放量/弹幕数：两个 stats-item 依次是播放和弹幕
        // 每个 stats-item 内部是「svg 图标 + 若干文本/数字节点」，数值可能被拆成多个节点，
        // 所以直接清掉除 svg 外的所有内容再写入新值，避免出现「262.4万 218.7万」这种串值
        const stats = node.querySelectorAll('.v-card__stats .stats-item');
        if( stats.length ) {
          const info = item.stat || {};
          const values = [info.view, info.danmaku];
          stats.forEach((stat, i) => {
            if( values[i] === undefined ) return;
            const icon = stat.querySelector('svg');
            stat.innerHTML = '';
            if( icon ) stat.appendChild(icon);
            stat.appendChild(document.createTextNode(' ' + fmtCount(values[i])));
          });
        }
        const duration = node.querySelector('.duration, .v-card__duration');
        if( duration && item.duration ) duration.textContent = fmtDuration(item.duration);
        fragment.appendChild(node);
      });
      cardBox.innerHTML = '';
      cardBox.appendChild(fragment);
      return true;
    };

    const refreshHome = async () => {
      if( refreshing ) return;
      refreshing = true;
      try {
        const url = `${RECOMMEND_API}?fresh_type=3&ps=12&fresh_idx=${freshIdx}` +
                    `&fresh_idx_1h=${freshIdx}&feed_version=V8&homepage_ver=1&brush=${freshIdx}`;
        freshIdx++;
        const res = await fetch(url, { credentials: 'include' }).then(r => r.json());
        const items = (res.data && res.data.item) || [];
        if( !items.length ) {
          // 接口没给数据就退回普通刷新，至少让页面重新加载一次
          window.location.reload();
          return;
        }
        if( !applyRecommend(items) ) {
          window.location.reload();
          return;
        }
        // 回到顶部，方便直接看第一批
        window.scrollTo(0, 0);
        ipc.sendToHost('home-refreshed');
      } catch(err) {
        window.location.reload();
      } finally {
        refreshing = false;
      }
    };

    ipc.on('refresh-home', refreshHome);
    // 调试标记：确认注入脚本在这个页面成功注册了刷新能力
    window.__biliminiHomeRefresh = true;
  }

  // 动态页重做样式
  else if( window.location.href.includes('t.bilibili.com/?tab=8') ) {
    const style = document.createElement('style');
    style.innerHTML = '#bili-header-m, .left-panel, .right-panel, .center-panel > .section-block, .sticky-bar { display: none !important }' +
                      '.home-content, .center-panel { width: 100% !important; }' +
                      '.card { min-width: 0 !important;}'
    document.head.appendChild(style)
  }

  // /blanc/:id才是真正的直播播放器所在页面
  // 它有时会作为iframe嵌入到直播间里，此时无法直接操作到播放器，所以转跳到实际播放器所在页面
  const liveId = /\/\/live\.bilibili\.com\/(\d+)/.exec(window.location.href);
  if ( liveId ) {
    window.location.href = `https://live.bilibili.com/blanc/${liveId[1]}?liteVersion=true`;
  }

  // 直播使用桌面版 HTML5 直播播放器
  else if ( /\/\/live\.bilibili\.com\/blanc\/\d+/.test(window.location.href) ) {
    let playerInitCheck = setInterval(() => {
      // 通过查询 HTML5 播放器 DIV 来判断页面加载
      if( document.querySelector('.bp-no-flash-tips') ) {
        // 切换 HTML5 播放器
        window.EmbedPlayer.loader();
      } else if( window.__PlayerInitialized ) {
        // 全屏播放器并隐藏聊天栏
        document.getElementsByTagName('body')[0].classList.add('player-full-win', 'hide-aside-area');
        // 隐藏聊天栏显示按钮
        let aside = document.getElementsByClassName('aside-area-toggle-btn')[0];
        aside.style.display = 'none';
        // 隐藏全屏播放器（在某些情况下会出现）的滚动条
        document.body.style.overflow = 'hidden';
        // 移除haruna
        const haruna = document.getElementById('my-dear-haruna-vm');
        haruna?.remove();
        clearInterval(playerInitCheck);
      } else if( ++checkCount > 1000 ) {
        clearInterval(playerInitCheck);
      }
    }, 100), checkCount = 0;
  }

  // 移除app广告
  function removeAppAd() {    appAdNode = document.querySelectorAll('[class*="OpenApp" i]');
    appAdNode.forEach((node) => {
      node.remove();
    });
  }
  removeAppAd();
});
