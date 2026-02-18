import { load as parseHTML } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';
import { storage } from '@libs/storage';

const COLLECTED_TAGS_KEY = 'collectedTags';

class ESJZone implements Plugin.PluginBase {
  id = 'esjzone';
  name = 'ESJZone';
  icon = 'src/cn/esjzone/icon.png';
  site = 'https://www.esjzone.cc';
  version = '2.5.1';

  // Enable WebView login for member-only content
  webStorageUtilized = true;

  /** Load collected tags from persistent storage and update filter options */
  private refreshTagOptions(): void {
    const saved: string[] = storage.get(COLLECTED_TAGS_KEY) || [];
    if (saved.length > 0) {
      const tagOptions = saved
        .slice()
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .map(t => ({ label: t, value: t }));
      this.filters.customTag.options = tagOptions;
    }
  }

  /** Save newly discovered tags to persistent storage */
  private collectTags(newTags: string[]): void {
    const saved: string[] = storage.get(COLLECTED_TAGS_KEY) || [];
    const tagSet = new Set(saved);
    let changed = false;
    for (const t of newTags) {
      if (t && !tagSet.has(t)) {
        tagSet.add(t);
        changed = true;
      }
    }
    if (changed) {
      storage.set(COLLECTED_TAGS_KEY, Array.from(tagSet));
    }
  }

  /** Fetch a single tag page and return parsed novels */
  private async fetchTagPage(
    tag: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      pageNo === 1
        ? `${this.site}/tags/${encodeURI(tag)}/`
        : `${this.site}/tags/${encodeURI(tag)}/${pageNo}.html`;
    const body = await fetchText(url);
    if (body === '') return [];
    return this.parseNovelList(body);
  }

  /** Fetch list page by category/sort */
  private async fetchListPage(
    category: string,
    sort: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const listPath = `list-${category}${sort}`;
    const url =
      pageNo === 1
        ? `${this.site}/${listPath}/`
        : `${this.site}/${listPath}/${pageNo}.html`;
    const body = await fetchText(url);
    if (body === '') return [];
    return this.parseNovelList(body);
  }

  /** Get selected tag from filters (single tag only) */
  private getSelectedTag(
    filters?: Plugin.PopularNovelsOptions<typeof this.filters>['filters'],
  ): string | undefined {
    const customTag = filters?.customTag?.value as unknown;
    if (Array.isArray(customTag)) {
      for (const t of customTag) {
        const trimmed = typeof t === 'string' ? t.trim() : '';
        if (trimmed) return trimmed;
      }
    } else if (
      customTag &&
      typeof customTag === 'string' &&
      customTag.trim() !== ''
    ) {
      return customTag.trim();
    }
    return undefined;
  }

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // Refresh tag options from storage on each browse
    this.refreshTagOptions();

    const selectedTag = this.getSelectedTag(filters);
    const category = filters?.category?.value || '1';
    const sort = filters?.sort?.value || '1';

    // Tag-based browsing
    if (selectedTag) {
      const tagNovels = await this.fetchTagPage(selectedTag, pageNo);
      const isDefaultCategorySort = category === '1' && sort === '1';
      if (isDefaultCategorySort) {
        return tagNovels;
      }

      // ESJ tag pages don't expose category/sort directly.
      // Intersect with list page so those filters still affect tag results.
      const listNovels = await this.fetchListPage(category, sort, pageNo);
      const listPathSet = new Set(listNovels.map(novel => novel.path));
      return tagNovels.filter(novel => listPathSet.has(novel.path));
    }

    const novels = await this.fetchListPage(category, sort, pageNo);

    // If no novels found in translated category, it likely requires login
    if (novels.length === 0 && category !== '2') {
      return [
        {
          name: '⚠ 需要登入才能瀏覽輕小說 — 請先在 WebView 中登入',
          path: '/my/login',
          cover: defaultCover,
        },
      ];
    }

    return novels;
  }

  /** Parse the card-based list page */
  private parseNovelList(body: string): Plugin.NovelItem[] {
    const $ = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];

    $('div.card.mb-30').each((_i, el) => {
      const cardEl = $(el);
      const linkEl = cardEl.find('a.card-img-tiles');
      const href = linkEl.attr('href');
      if (!href) return;

      const novelName = cardEl.find('.card-title a').text().trim();
      let novelCover =
        cardEl.find('.main-img .lazyload').attr('data-src') || '';

      if (novelCover.includes('/assets/img/empty.jpg') || novelCover === '') {
        novelCover = defaultCover;
      } else if (novelCover.startsWith('/') && !novelCover.startsWith('//')) {
        novelCover = this.site + novelCover;
      }

      // Detect R18/18+ badge from card
      // ESJZone uses <div class="product-badge top">18+</div> for adult content
      let badge: string | undefined;
      const productBadge = cardEl.find('.product-badge').text().trim();
      if (
        productBadge === '18+' ||
        /\bR-?18\b/i.test(productBadge) ||
        /\b18\+/.test(productBadge)
      ) {
        badge = 'R18';
      }

      // Extract rating and word count from card-other columns
      let ratingStr = '';
      let wordCountStr = '';
      cardEl.find('.card-other .column').each((_j, col) => {
        const colEl = $(col);
        if (colEl.find('.icon-star-s').length > 0) {
          ratingStr = colEl.text().trim();
        } else if (colEl.find('.icon-file-text').length > 0) {
          wordCountStr = colEl.text().trim();
        }
      });

      // Build info string for cover overlay (e.g. "★5.0 | 42,795字")
      const infoParts: string[] = [];
      if (ratingStr && ratingStr !== '0') {
        infoParts.push('★' + ratingStr);
      }
      if (wordCountStr) {
        infoParts.push(wordCountStr + '字');
      }

      const item: Plugin.NovelItem = {
        name: novelName,
        path: href,
        cover: novelCover,
      };
      if (badge) {
        item.badge = badge;
      }
      if (infoParts.length > 0) {
        item.info = infoParts.join(' | ');
      }

      novels.push(item);
    });

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = this.site + novelPath;
    const body = await fetchText(url);
    if (body === '') throw Error('無法獲取小說資訊，請檢查網路');

    const $ = parseHTML(body);

    // Detect login-required / redirected pages
    const pageText = $('body').text();
    const hasLoginPrompt =
      pageText.includes('請先登入') ||
      pageText.includes('请先登入') ||
      pageText.includes('登入 / 註冊');
    const titleEl = $('h2.text-normal');
    const hasNovelContent = titleEl.length > 0;

    if (!hasNovelContent && hasLoginPrompt) {
      const novel: Plugin.SourceNovel = {
        path: novelPath,
        chapters: [],
        name: '需要登入才能瀏覽此作品',
        summary:
          '此作品需要登入 ESJZone 帳號才能瀏覽。\n' +
          '請在 WebView 中開啟此頁面並登入後重試。\n\n' +
          '操作步驟：\n' +
          '1. 點擊右上角的 WebView 圖示\n' +
          '2. 在網頁中登入 ESJZone 帳號\n' +
          '3. 返回後重新整理此頁面',
      };
      novel.cover = defaultCover;
      return novel;
    }

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      chapters: [],
      name: titleEl.text().trim() || 'Untitled',
    };

    // Cover image
    const coverImg = $('div.product-gallery img').attr('src') || '';
    if (coverImg) {
      novel.cover = coverImg.startsWith('/') ? this.site + coverImg : coverImg;
    } else {
      novel.cover = defaultCover;
    }

    // Parse metadata from book-detail list
    $('ul.book-detail li').each((_i, el) => {
      const text = $(el).text().trim();
      if (text.startsWith('作者:') || text.startsWith('作者：')) {
        novel.author =
          $(el).find('a').text().trim() || text.replace(/作者[:：]\s*/, '');
      }
      if (text.startsWith('類型:') || text.startsWith('類型：')) {
        const typeText = text.replace(/類型[:：]\s*/, '').trim();
        if (typeText) {
          novel.status = typeText.includes('完結')
            ? NovelStatus.Completed
            : NovelStatus.Ongoing;
        }
      }
      // Extract word count (字數 / 總字數)
      const wordCountMatch = text.match(/(?:字數|總字數)[:：]?\s*([\d,]+)/);
      if (wordCountMatch) {
        const count = parseInt(wordCountMatch[1].replace(/,/g, ''), 10);
        if (!isNaN(count) && count > 0) {
          novel.wordCount = count;
        }
      }
    });

    if (!novel.status) {
      novel.status = NovelStatus.Ongoing;
    }

    // Rating
    const ratingText = $('div.d-inline.display-3').first().text().trim();
    if (ratingText) {
      const rating = parseFloat(ratingText);
      if (!isNaN(rating)) {
        novel.rating = rating;
      }
    }

    // Summary
    const summaryEl = $('div.description');
    if (summaryEl.length) {
      novel.summary = summaryEl.text().trim();
    }

    // Tags / Genres
    const tagSet = new Set<string>();
    $('section.widget-tags a.tag').each((_i, el) => {
      const tagText = $(el).text().trim();
      if (tagText) tagSet.add(tagText);
    });
    if (tagSet.size === 0) {
      $('a.tag').each((_i, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('/tags/')) {
          const tagText = $(el).text().trim();
          if (tagText) tagSet.add(tagText);
        }
      });
    }
    const tags = Array.from(tagSet);
    if (tags.length > 0) {
      novel.genres = tags.join(',');
      // Collect tags for the autocomplete tag filter
      this.collectTags(tags);
    }

    // Extract update date from book-detail metadata (e.g. "更新日期: 2026-02-15")
    let updateDate = '';
    $('ul.book-detail li').each((_i, el) => {
      const text = $(el).text().trim();
      if (text.startsWith('更新日期:') || text.startsWith('更新日期：')) {
        const match = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
        if (match) {
          updateDate = match[1];
        }
      }
    });

    // Chapters from #chapterList
    const chapters: Plugin.ChapterItem[] = [];
    let chapterNumber = 0;

    $('#chapterList a').each((_i, el) => {
      const chapterHref = $(el).attr('href');
      if (!chapterHref) return;

      const chapterName =
        $(el).attr('data-title')?.trim() || $(el).text().trim();
      if (!chapterName) return;

      chapterNumber++;

      let chapterPath = chapterHref;
      if (chapterPath.startsWith(this.site)) {
        chapterPath = chapterPath.replace(this.site, '');
      } else if (chapterPath.startsWith('https://www.esjzone.cc')) {
        chapterPath = chapterPath.replace('https://www.esjzone.cc', '');
      }

      chapters.push({
        name: chapterName,
        path: chapterPath,
        chapterNumber: chapterNumber,
      });
    });

    // Assign update date to the latest (first) chapter's releaseTime
    if (updateDate && chapters.length > 0) {
      chapters[0].releaseTime = updateDate;
    }

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = this.site + chapterPath;
    const body = await fetchText(url);
    if (body === '') throw Error('無法獲取章節內容，請檢查網路');

    const $ = parseHTML(body);

    const pageText = $('body').text();
    const hasForumContent = $('div.forum-content').length > 0;

    if (
      pageText.includes('請先登入') ||
      pageText.includes('请先登入') ||
      pageText.includes('請登入後再訪問') ||
      pageText.includes('需要登入') ||
      (!hasForumContent && pageText.includes('登入 / 註冊'))
    ) {
      return '<p style="text-align:center;color:red;font-weight:bold;">此內容需要登入才能閱讀。<br/>請點擊右上角 WebView 圖示，在網頁中登入 ESJZone 帳號後返回重試。</p>';
    }

    if (
      pageText.includes('成人確認') ||
      pageText.includes('年齡確認') ||
      pageText.includes('未成年請勿') ||
      pageText.includes('18歲以上')
    ) {
      return '<p style="text-align:center;color:red;font-weight:bold;">此內容需要成人驗證。<br/>請在 WebView 中完成年齡確認後重試。</p>';
    }

    if (
      pageText.includes('密碼') ||
      pageText.includes('密码') ||
      $('input[type="password"]').length > 0
    ) {
      return '<p style="text-align:center;color:red;font-weight:bold;">此章節受密碼保護，無法直接閱讀。</p>';
    }

    const contentEl = $('div.forum-content');
    if (contentEl.length === 0) {
      return '<p>無法找到章節內容。</p>';
    }

    contentEl.find('script, style, .ad, ins.adsbygoogle').remove();

    const chapterText = contentEl.html() || '';
    return chapterText;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url =
      pageNo === 1
        ? `${this.site}/tags/${encodeURI(searchTerm)}/`
        : `${this.site}/tags/${encodeURI(searchTerm)}/${pageNo}.html`;

    const body = await fetchText(url);
    if (body === '') return [];

    return this.parseNovelList(body);
  }

  async parseComments(path: string): Promise<Plugin.CommentItem[]> {
    // Comments only appear on detail pages (/detail/xxx.html).
    // Chapter/forum pages (/forum/xxx/yyy.html) have no comment section.
    const url = this.site + path;
    const body = await fetchText(url);
    if (body === '') return [];

    const $ = parseHTML(body);
    const comments: Plugin.CommentItem[] = [];

    $('section.comments-section .comment').each((_i, el) => {
      const commentEl = $(el);

      const author =
        commentEl.find('.comment-title a').first().text().trim() ||
        commentEl.find('.comment-title').first().text().trim() ||
        '';

      const dateMeta = commentEl
        .find('.comment-meta')
        .not('.comment-floor')
        .first()
        .text()
        .trim();

      const avatar =
        commentEl.find('.lazyload-author-ava').first().attr('data-src') || '';

      const quotedText = commentEl.find('blockquote p').text().trim();
      const contentText = commentEl
        .find('p.comment-text')
        .first()
        .text()
        .trim();

      const content = quotedText
        ? `「${quotedText}」\n${contentText}`
        : contentText;

      if (content) {
        comments.push({
          author: author || '匿名',
          content,
          date: dateMeta || undefined,
          avatar: avatar
            ? avatar.startsWith('http')
              ? avatar
              : `${this.site}${avatar}`
            : undefined,
        });
      }
    });

    return comments;
  }

  resolveUrl = (path: string) => this.site + path;

  filters = {
    category: {
      label: '分類',
      value: '1',
      options: [
        { label: '全部小說（需登入）', value: '0' },
        { label: '日本輕小說（需登入）', value: '1' },
        { label: '原創小說', value: '2' },
        { label: '韓國輕小說（需登入）', value: '3' },
      ],
      type: FilterTypes.Picker,
    },
    sort: {
      label: '排序',
      value: '1',
      options: [
        { label: '最新更新', value: '1' },
        { label: '最新上架', value: '2' },
        { label: '最高評分', value: '3' },
        { label: '最多觀看', value: '4' },
        { label: '最多文章', value: '5' },
        { label: '最多討論', value: '6' },
        { label: '最多收藏', value: '7' },
        { label: '最多字數', value: '8' },
      ],
      type: FilterTypes.Picker,
    },
    customTag: {
      label: '自訂標籤搜尋（單選＋自動完成）',
      value: [] as string[],
      options: [] as { label: string; value: string }[],
      maxSelections: 1,
      type: FilterTypes.AutocompleteMulti,
    },
  } satisfies Filters;
}

export default new ESJZone();
