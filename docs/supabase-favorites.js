// ============================================================
// 楽曲お気に入り（ブックマーク）機能 — Supabase 連携
// index.html から読み込んで利用する。UI・状態管理をここに集約。
// ============================================================
(function () {
  "use strict";

  // --- Supabase 設定（公開前提のキーなので埋め込みで OK） ---
  const SUPABASE_URL = "https://fenpzciyuwymcejsinul.supabase.co";
  const SUPABASE_KEY = "sb_publishable_VCkn0BtvJ1x4aThgurDYmQ_E0ybr4Lt";

  // 公開サイトのベース URL（piece_key の導出・復元に使用）
  const BASE_URL = "https://mai0108.github.io/gagakufu_iiif_manifest";

  // グローバル公開オブジェクト（index.html の displayPiecesList から参照される）
  const GFav = (window.GFav = {
    BASE_URL: BASE_URL,
    favoriteKeys: new Set(), // ログインユーザーのお気に入り piece_key を保持
    userId: null,
    _favRender: false, // お気に入り一覧を描画中かどうかのフラグ
  });

  let client = null; // Supabase クライアント

  // --- 属性値の簡易エスケープ ---
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ------------------------------------------------------------
  // piece_key の正規化
  // 楽曲の @id（環境によりホストが異なる）から、ホスト・ベースパスを除いた
  // 相対パス（例: "100270332_pieces/笙_双調_入破_1116-1118.json"）を導出する。
  // ローカル/公開のどちらの環境でも同じキーになる。
  // ------------------------------------------------------------
  GFav.toPieceKey = function (id) {
    if (!id) return "";
    let key = String(id);
    if (key.startsWith(BASE_URL)) {
      // 公開環境: ベース URL を除去（日本語はそのまま）
      key = key.slice(BASE_URL.length);
    } else {
      // ローカル等: ホスト部分を除いてパスだけにする
      try {
        key = new URL(key).pathname;
      } catch (e) {
        /* 相対パスならそのまま */
      }
    }
    key = key.replace(/^\/+/, "");
    // ベースパスの差異（/docs/ 等）を吸収し "NNN_pieces/…" 以降に揃える
    const m = key.match(/(\d+_pieces\/.+)$/);
    if (m) key = m[1];
    // new URL 経由でパーセントエンコードされた日本語を元に戻して統一
    try {
      key = decodeURIComponent(key);
    } catch (e) {
      /* デコード不能ならそのまま */
    }
    return key;
  };

  // piece_key から @id（公開 URL）を復元。loadManifest がローカル変換を行う。
  GFav.toManifestUrl = function (pieceKey) {
    return BASE_URL + "/" + pieceKey;
  };

  GFav.isFavorite = function (pieceKey) {
    return GFav.favoriteKeys.has(pieceKey);
  };

  // ------------------------------------------------------------
  // ★/☆ ボタンの HTML を生成（displayPiecesList から呼ばれる）
  // イベントは #piecesList への委譲で処理するため、メタデータは data 属性に持たせる
  // ------------------------------------------------------------
  GFav.starButtonHtml = function (piece) {
    const meta = (piece && piece.metadata) || {};
    const key = GFav.toPieceKey(piece && piece["@id"]);
    const active = GFav.favoriteKeys.has(key);
    return (
      '<button class="fav-btn' +
      (active ? " active" : "") +
      '" type="button"' +
      ' data-piece-key="' + escAttr(key) + '"' +
      ' data-name="' + escAttr(meta.piece_name || "") + '"' +
      ' data-instrument="' + escAttr(meta.instrument || "") + '"' +
      ' data-mode="' + escAttr(meta.mode || "") + '"' +
      ' data-collection="' + escAttr(meta.collection || "") + '"' +
      ' data-page="' + escAttr(meta.page_range || "") + '"' +
      ' title="' + (active ? "お気に入りから削除" : "お気に入りに追加") + '"' +
      ' aria-label="お気に入り">' +
      (active ? "★" : "☆") +
      "</button>"
    );
  };

  // 特定キーの★ボタン表示を更新
  function updateStarButtons(pieceKey) {
    const active = GFav.favoriteKeys.has(pieceKey);
    const sel =
      '.fav-btn[data-piece-key="' + (window.CSS && CSS.escape ? CSS.escape(pieceKey) : pieceKey) + '"]';
    let btns;
    try {
      btns = document.querySelectorAll(sel);
    } catch (e) {
      // CSS.escape 非対応や特殊文字対策のフォールバック
      btns = Array.prototype.filter.call(
        document.querySelectorAll(".fav-btn"),
        function (b) {
          return b.dataset.pieceKey === pieceKey;
        }
      );
    }
    Array.prototype.forEach.call(btns, function (btn) {
      btn.textContent = active ? "★" : "☆";
      btn.classList.toggle("active", active);
      btn.title = active ? "お気に入りから削除" : "お気に入りに追加";
    });
  }

  // ------------------------------------------------------------
  // 認証まわりのメッセージ表示
  // ------------------------------------------------------------
  function setAuthMsg(text, type) {
    const el = document.getElementById("favAuthMsg");
    if (!el) return;
    el.textContent = text || "";
    el.style.color =
      type === "error" ? "#c62828" : type === "success" ? "#2e7d32" : "#1565c0";
  }

  // Supabase の英語エラーを日本語に寄せる
  function jpAuthError(err) {
    const msg = (err && err.message) || "";
    if (/Invalid login credentials/i.test(msg))
      return "メールアドレスまたはパスワードが正しくありません。";
    if (/Email not confirmed/i.test(msg))
      return "メールアドレスが未確認です。確認メールのリンクをクリックしてください。";
    if (/User already registered/i.test(msg) || /already registered/i.test(msg))
      return "このメールアドレスは既に登録されています。ログインしてください。";
    if (/Password should be at least/i.test(msg))
      return "パスワードは6文字以上で入力してください。";
    if (/valid email/i.test(msg) || /invalid.*email/i.test(msg))
      return "メールアドレスの形式が正しくありません。";
    if (/rate limit/i.test(msg))
      return "リクエストが多すぎます。しばらく待って再度お試しください。";
    return "エラーが発生しました: " + msg;
  }

  // ------------------------------------------------------------
  // お気に入りの一括ロード（ログイン時）
  // ------------------------------------------------------------
  async function loadFavorites() {
    if (!client || !GFav.userId) {
      GFav.favoriteKeys = new Set();
      return;
    }
    try {
      const { data, error } = await client
        .from("favorites")
        .select("manifest_url");
      if (error) throw error;
      // manifest_url 列から piece_key を導出して内部状態に格納
      GFav.favoriteKeys = new Set(
        (data || []).map((r) => GFav.toPieceKey(r.manifest_url))
      );
    } catch (e) {
      console.error("お気に入りの読み込みに失敗:", e);
      GFav.favoriteKeys = new Set();
    }
    // 検索結果が表示されていれば★表示を反映
    if (typeof window.refreshFavoriteStars === "function") {
      window.refreshFavoriteStars();
    }
  }

  // ------------------------------------------------------------
  // お気に入りの追加／削除トグル
  // ------------------------------------------------------------
  async function toggleFavorite(btn) {
    if (!GFav.userId) {
      setAuthMsg("お気に入り機能を使うにはログインしてください。", "error");
      return;
    }
    const d = btn.dataset;
    const key = d.pieceKey;
    if (!key) return;

    // 二重クリック防止
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";

    try {
      if (GFav.favoriteKeys.has(key)) {
        // 削除
        const { error } = await client
          .from("favorites")
          .delete()
          .eq("user_id", GFav.userId)
          .eq("manifest_url", GFav.toManifestUrl(key));
        if (error) throw error;
        GFav.favoriteKeys.delete(key);
        updateStarButtons(key);

        // お気に入り一覧を表示中なら、その場でカードを取り除く
        const list = document.getElementById("piecesList");
        if (list && list.dataset.view === "favorites") {
          const item = btn.closest(".piece-item");
          if (item) item.remove();
          updateFavStats();
        }
      } else {
        // 追加（unique 制約の有無が不明なため upsert ではなく insert を使う。
        // 事前に favoriteKeys で重複チェック済みなので実用上問題ない）
        const row = {
          user_id: GFav.userId,
          manifest_url: GFav.toManifestUrl(key),
          piece_name: d.name || null,
          instrument: d.instrument || null,
          mode: d.mode || null,
          collection: d.collection || null,
        };
        const { error } = await client.from("favorites").insert(row);
        // unique 制約違反（重複挿入）は成功扱いにする
        if (error && error.code !== "23505") throw error;
        GFav.favoriteKeys.add(key);
        updateStarButtons(key);
      }
    } catch (e) {
      console.error("お気に入り更新に失敗:", e);
      setAuthMsg("お気に入りの更新に失敗しました: " + (e.message || ""), "error");
    } finally {
      btn.dataset.busy = "";
    }
  }

  // お気に入り一覧表示中の件数表示を更新
  function updateFavStats() {
    const stats = document.getElementById("searchStats");
    const list = document.getElementById("piecesList");
    if (!stats || !list) return;
    const count = list.querySelectorAll(".piece-item").length;
    stats.textContent = "⭐ お気に入り " + count + "曲";
  }

  // ------------------------------------------------------------
  // お気に入り一覧の表示（#piecesList にカード形式で描画）
  // ------------------------------------------------------------
  async function showFavorites() {
    if (!GFav.userId) {
      setAuthMsg("お気に入り機能を使うにはログインしてください。", "error");
      return;
    }
    const results = document.getElementById("searchResults");
    const stats = document.getElementById("searchStats");
    const list = document.getElementById("piecesList");
    if (!results || !list) return;

    results.style.display = "block";
    if (stats) stats.textContent = "⭐ お気に入りを読み込み中...";

    try {
      const { data, error } = await client
        .from("favorites")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;

      // manifest_url が無い行は除外しつつ、最新の状態を Set にも反映
      const rows = (data || []).filter((r) => r.manifest_url);
      GFav.favoriteKeys = new Set(
        rows.map((r) => GFav.toPieceKey(r.manifest_url))
      );

      if (rows.length === 0) {
        if (stats) stats.textContent = "⭐ お気に入り 0曲";
        list.dataset.view = "favorites";
        list.innerHTML =
          '<div class="piece-item">お気に入りはまだありません。楽曲の☆を押して追加できます。</div>';
        return;
      }

      // 通常の楽曲アイテムと同じ形に整形して displayPiecesList で描画
      // page_range 列は存在しないため manifest_url のファイル名末尾から導出する
      const pieces = rows.map((r) => {
        const m = r.manifest_url.match(/_(\d+(?:-\d+)?)\.json$/);
        return {
          "@id": r.manifest_url,
          metadata: {
            piece_name: r.piece_name,
            instrument: r.instrument,
            mode: r.mode,
            collection: r.collection,
            page_range: m ? m[1] : null,
          },
        };
      });

      if (stats) stats.textContent = "⭐ お気に入り " + pieces.length + "曲";

      // displayPiecesList にお気に入り描画であることを伝える
      GFav._favRender = true;
      window.displayPiecesList(pieces);
      GFav._favRender = false;
    } catch (e) {
      console.error("お気に入り一覧の取得に失敗:", e);
      if (stats) stats.textContent = "";
      list.innerHTML =
        '<div class="piece-item">お気に入りの取得に失敗しました。</div>';
    }
  }

  // ------------------------------------------------------------
  // ログイン状態に応じた UI 切り替え
  // ------------------------------------------------------------
  function updateAuthUi(user) {
    const loggedOut = document.getElementById("favLoggedOut");
    const loggedIn = document.getElementById("favLoggedIn");
    const emailSpan = document.getElementById("favUserEmail");
    if (!loggedOut || !loggedIn) return;

    if (user) {
      loggedOut.style.display = "none";
      loggedIn.style.display = "block";
      if (emailSpan) emailSpan.textContent = user.email || "";
    } else {
      loggedOut.style.display = "block";
      loggedIn.style.display = "none";
    }
  }

  // ------------------------------------------------------------
  // ログイン UI の DOM を組み立ててサイドバーに挿入
  // ------------------------------------------------------------
  function injectUi() {
    // スタイル注入（★ボタン・ログイン欄）
    const style = document.createElement("style");
    style.textContent =
      ".piece-item { position: relative; }" +
      ".piece-item .piece-title { padding-right: 26px; }" +
      ".fav-btn { position: absolute; top: 8px; right: 8px; background: none;" +
      " border: none; cursor: pointer; font-size: 20px; line-height: 1;" +
      " color: #f5b301; padding: 2px; border-radius: 50%; z-index: 2;" +
      " transition: transform .15s ease, background-color .15s ease; }" +
      ".fav-btn:hover { transform: scale(1.2); background: rgba(0,0,0,0.06); }" +
      ".fav-btn.active { color: #f5b301; }" +
      "#favAuthSection input.fav-input { width: 100%; padding: 8px 10px;" +
      " border: 1px solid #ddd; border-radius: 4px; font-size: 13px;" +
      " margin-bottom: 8px; }" +
      "#favAuthSection input.fav-input:focus { outline: none;" +
      " border-color: #2196f3; box-shadow: 0 0 5px rgba(33,150,243,0.3); }";
    document.head.appendChild(style);

    // ログイン欄（サイドバー先頭に .section として挿入）
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) {
      const sec = document.createElement("div");
      sec.className = "section";
      sec.id = "favAuthSection";
      sec.innerHTML =
        "<h3>🔑 ログイン</h3>" +
        '<div id="favLoggedOut">' +
        '  <input type="email" id="favEmail" class="fav-input" placeholder="メールアドレス" autocomplete="email">' +
        '  <input type="password" id="favPassword" class="fav-input" placeholder="パスワード（6文字以上）" autocomplete="current-password">' +
        '  <div style="display:flex; gap:8px;">' +
        '    <button class="btn" id="favLoginBtn" style="flex:1;">ログイン</button>' +
        '    <button class="btn secondary" id="favSignupBtn" style="flex:1; margin-left:0;">新規登録</button>' +
        "  </div>" +
        "</div>" +
        '<div id="favLoggedIn" style="display:none;">' +
        '  <div style="font-size:13px; color:#333; margin-bottom:8px;">' +
        '    ログイン中: <span id="favUserEmail" style="font-weight:600; word-break:break-all;"></span>' +
        "  </div>" +
        '  <button class="btn-small" id="favLogoutBtn">ログアウト</button>' +
        "</div>" +
        '<div id="favAuthMsg" style="font-size:12px; margin-top:8px; line-height:1.5;"></div>';
      sidebar.insertBefore(sec, sidebar.firstChild);
    }

    // 「⭐ お気に入り」一覧ボタンを検索アクション欄に追加
    const actions = document.querySelector("#search-section .search-actions");
    if (actions) {
      const favBtn = document.createElement("button");
      favBtn.className = "btn-small";
      favBtn.id = "favShowBtn";
      favBtn.type = "button";
      favBtn.textContent = "⭐ お気に入り";
      actions.appendChild(favBtn);
    }
  }

  // ------------------------------------------------------------
  // イベント登録
  // ------------------------------------------------------------
  function bindEvents() {
    // ★ボタン: #piecesList へのイベント委譲
    // .piece-item 本体の inline onclick（ビューアー起動）より先に処理するため
    // キャプチャ段階で捕まえて伝播を止める
    const list = document.getElementById("piecesList");
    if (list) {
      list.addEventListener(
        "click",
        function (e) {
          const btn = e.target.closest(".fav-btn");
          if (!btn) return;
          e.stopPropagation(); // ビューアーで開く動作を止める
          e.preventDefault();
          toggleFavorite(btn);
        },
        true
      );
    }

    const loginBtn = document.getElementById("favLoginBtn");
    const signupBtn = document.getElementById("favSignupBtn");
    const logoutBtn = document.getElementById("favLogoutBtn");
    const showBtn = document.getElementById("favShowBtn");
    const pwInput = document.getElementById("favPassword");

    function getCreds() {
      const email = (document.getElementById("favEmail").value || "").trim();
      const password = document.getElementById("favPassword").value || "";
      return { email, password };
    }

    async function doLogin() {
      const { email, password } = getCreds();
      if (!email || !password) {
        setAuthMsg("メールアドレスとパスワードを入力してください。", "error");
        return;
      }
      setAuthMsg("ログイン中...", "info");
      const { error } = await client.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        setAuthMsg(jpAuthError(error), "error");
      } else {
        setAuthMsg("", "info");
      }
      // 成功時は onAuthStateChange 側で UI 更新・お気に入りロード
    }

    async function doSignup() {
      const { email, password } = getCreds();
      if (!email || !password) {
        setAuthMsg("メールアドレスとパスワードを入力してください。", "error");
        return;
      }
      if (password.length < 6) {
        setAuthMsg("パスワードは6文字以上で入力してください。", "error");
        return;
      }
      setAuthMsg("登録中...", "info");
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) {
        setAuthMsg(jpAuthError(error), "error");
        return;
      }
      // メール確認が必要な設定ではセッションが返らない
      if (data && data.session) {
        setAuthMsg("登録が完了しました。", "success");
      } else {
        setAuthMsg(
          "確認メールを送信しました。メール内のリンクをクリックして登録を完了してください。",
          "success"
        );
      }
    }

    if (loginBtn) loginBtn.addEventListener("click", doLogin);
    if (signupBtn) signupBtn.addEventListener("click", doSignup);
    if (logoutBtn)
      logoutBtn.addEventListener("click", async function () {
        await client.auth.signOut();
        setAuthMsg("ログアウトしました。", "info");
      });
    if (showBtn) showBtn.addEventListener("click", showFavorites);

    // Enter キーでログイン
    if (pwInput)
      pwInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") doLogin();
      });
  }

  // ------------------------------------------------------------
  // displayPiecesList をラップし、描画時に検索/お気に入りの別を記録
  // （★削除時にお気に入り一覧のカードを取り除く判定に使う）
  // ------------------------------------------------------------
  function wrapDisplayPiecesList() {
    if (
      typeof window.displayPiecesList === "function" &&
      !window.displayPiecesList.__favWrapped
    ) {
      const orig = window.displayPiecesList;
      const wrapped = function (pieces) {
        const list = document.getElementById("piecesList");
        if (list) list.dataset.view = GFav._favRender ? "favorites" : "search";
        return orig.apply(this, arguments);
      };
      wrapped.__favWrapped = true;
      window.displayPiecesList = wrapped;
    }
  }

  // ------------------------------------------------------------
  // 初期化
  // ------------------------------------------------------------
  function init() {
    if (!window.supabase || !window.supabase.createClient) {
      console.error(
        "supabase-js が読み込まれていません。お気に入り機能は無効です。"
      );
      return;
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    GFav.client = client;

    injectUi();
    bindEvents();
    wrapDisplayPiecesList();

    // 認証状態の監視（初期セッションもここで通知される）
    client.auth.onAuthStateChange(function (event, session) {
      const user = session && session.user;
      GFav.userId = user ? user.id : null;
      updateAuthUi(user);
      if (user) {
        loadFavorites();
      } else {
        GFav.favoriteKeys = new Set();
        if (typeof window.refreshFavoriteStars === "function") {
          window.refreshFavoriteStars();
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
