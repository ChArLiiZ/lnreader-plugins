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
  version = '2.2.0';

  // Enable WebView login for member-only content
  webStorageUtilized = true;

  /** Load collected tags from persistent storage and update filter options */
  private refreshTagOptions(): void {
    const saved: string[] = storage.get(COLLECTED_TAGS_KEY) || [];
    if (saved.length > 0) {
      this.filters.tags.options = saved
        .slice()
        .sort((a, b) => a.localeCompare(b, 'zh'))
        .map(t => ({ label: t, value: t }));
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

  /** Get all selected tags from filters (CheckboxGroup + custom TextInput) */
  private getSelectedTags(
    filters?: Plugin.PopularNovelsOptions<typeof this.filters>['filters'],
  ): string[] {
    const tags: string[] = [];
    const checkboxTags = filters?.tags?.value;
    if (checkboxTags && Array.isArray(checkboxTags)) {
      for (const t of checkboxTags) {
        if (t && !tags.includes(t)) tags.push(t);
      }
    }
    const customTag = filters?.customTag?.value;
    if (customTag && typeof customTag === 'string' && customTag.trim() !== '') {
      const trimmed = customTag.trim();
      if (!tags.includes(trimmed)) tags.push(trimmed);
    }
    return tags;
  }

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // Refresh tag options from storage on each browse
    this.refreshTagOptions();

    const selectedTags = this.getSelectedTags(filters);
    const category = filters?.category?.value || '1';
    const sort = filters?.sort?.value || '1';

    // Tag-based browsing
    if (selectedTags.length === 1) {
      // Single tag: direct fetch with pagination support
      return this.fetchTagPage(selectedTags[0], pageNo);
    }

    if (selectedTags.length > 1) {
      // Multiple tags: fetch first page of each, then intersect by path
      if (pageNo > 1) return []; // Multi-tag intersection only works on page 1

      const results = await Promise.all(
        selectedTags.map(tag => this.fetchTagPage(tag, 1)),
      );

      // Intersect: keep novels that appear in ALL tag results
      const pathCountMap = new Map<
        string,
        { count: number; novel: Plugin.NovelItem }
      >();
      for (const novels of results) {
        for (const novel of novels) {
          const existing = pathCountMap.get(novel.path);
          if (existing) {
            existing.count++;
          } else {
            pathCountMap.set(novel.path, { count: 1, novel });
          }
        }
      }

      const intersection: Plugin.NovelItem[] = [];
      pathCountMap.forEach(({ count, novel }) => {
        if (count === selectedTags.length) {
          intersection.push(novel);
        }
      });
      return intersection;
    }

    // List page: /list-{category}{sort}/{page}.html
    const listPath = `list-${category}${sort}`;
    const url =
      pageNo === 1
        ? `${this.site}/${listPath}/`
        : `${this.site}/${listPath}/${pageNo}.html`;

    const body = await fetchText(url);
    if (body === '') throw Error('無法獲取小說列表，請檢查網路');

    const novels = this.parseNovelList(body);

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

      const item: Plugin.NovelItem = {
        name: novelName,
        path: href,
        cover: novelCover,
      };
      if (badge) {
        item.badge = badge;
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
    const tags: string[] = [];
    $('section.widget-tags a.tag').each((_i, el) => {
      const tagText = $(el).text().trim();
      if (tagText) tags.push(tagText);
    });
    if (tags.length === 0) {
      $('a.tag').each((_i, el) => {
        const href = $(el).attr('href') || '';
        if (href.startsWith('/tags/')) {
          const tagText = $(el).text().trim();
          if (tagText && !tags.includes(tagText)) {
            tags.push(tagText);
          }
        }
      });
    }
    if (tags.length > 0) {
      novel.genres = tags.join(',');
      // Collect tags for the CheckboxGroup filter
      this.collectTags(tags);
    }

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
    tags: {
      label: '標籤（瀏覽小說後自動收集）',
      value: [] as string[],
      options: [] as { label: string; value: string }[],
      type: FilterTypes.CheckboxGroup,
    },
    customTag: {
      label: '自訂標籤搜尋',
      value: '',
      type: FilterTypes.TextInput,
    },
  } satisfies Filters;
}

export default new ESJZone();
