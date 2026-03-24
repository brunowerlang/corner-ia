function cornerIaInit() {
  console.log("[Corner IA] JS init started");

  /* Hide JS diagnostic banner */
  var jsCheck = document.getElementById("jsCheck");
  if (jsCheck) jsCheck.style.display = "none";

  var cfg = document.getElementById("appConfig");
  if (!cfg) { console.error("[Corner IA] appConfig element not found"); return; }
  var API_URL = cfg.getAttribute("data-api");
  var CID = cfg.getAttribute("data-cid");
  var TOKEN = cfg.getAttribute("data-token");
  console.log("[Corner IA] Config loaded, API:", API_URL ? "set" : "MISSING", "CID:", CID ? "set" : "MISSING");

  var errorBox = document.getElementById("errorBox");
  var statusBox = document.getElementById("statusBox");
  var loading = document.getElementById("loading");
  var loadingText = document.getElementById("loadingText");
  var latestResult = document.getElementById("latestResult");
  var latestImg = document.getElementById("latestImg");
  var latestDl = document.getElementById("latestDl");
  var creditCount = document.getElementById("creditCount");
  var creditCount2 = document.getElementById("creditCount2");
  var galleryGrid = document.getElementById("galleryGrid");

  function showError(msg) {
    if (errorBox) { errorBox.textContent = msg; errorBox.style.display = "block"; }
    if (statusBox) statusBox.style.display = "none";
    window.scrollTo({top:0, behavior:"smooth"});
  }
  function showStatus(msg) {
    if (statusBox) { statusBox.textContent = msg; statusBox.style.display = "block"; }
    if (errorBox) errorBox.style.display = "none";
  }
  function hideMessages() {
    if (errorBox) errorBox.style.display = "none";
    if (statusBox) statusBox.style.display = "none";
  }
  function updateCredits(n) {
    if (creditCount) creditCount.textContent = n;
    if (creditCount2) creditCount2.textContent = n;
  }

  /* --- Pose selector (divs + hidden input) --- */
  var poseInput = document.getElementById("poseInput");
  var poseGrid = document.getElementById("poseGrid");
  if (poseGrid && poseInput) {
    var poseOpts = poseGrid.querySelectorAll(".pose-option");
    console.log("[Corner IA] Pose options found:", poseOpts.length);
    for (var p = 0; p < poseOpts.length; p++) {
      poseOpts[p].addEventListener("click", function(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        for (var i = 0; i < poseOpts.length; i++) poseOpts[i].classList.remove("active");
        this.classList.add("active");
        poseInput.value = this.getAttribute("data-pose");
        console.log("[Corner IA] Pose selected:", poseInput.value);
      });
    }
  }

  /* --- Drop zone / File preview --- */
  var zone = document.getElementById("garmentDrop");
  var fileInput = document.getElementById("garmentInput");
  var preview = document.getElementById("garmentPreview");

  if (zone && fileInput) {
    /* Click on zone opens file picker */
    zone.addEventListener("click", function(ev) {
      if (ev.target !== fileInput) {
        fileInput.click();
      }
    });

    /* Drag & drop */
    zone.addEventListener("dragover", function(e) { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", function() { zone.classList.remove("dragover"); });
    zone.addEventListener("drop", function(e) {
      e.preventDefault();
      zone.classList.remove("dragover");
      if (e.dataTransfer && e.dataTransfer.files.length) {
        fileInput.files = e.dataTransfer.files;
        showFilePreview(fileInput.files[0]);
      }
    });

    /* File selected via picker */
    fileInput.addEventListener("change", function() {
      console.log("[Corner IA] File input changed, files:", fileInput.files.length);
      if (fileInput.files.length) showFilePreview(fileInput.files[0]);
    });
  }

  function showFilePreview(file) {
    if (!preview || !file) return;
    try {
      preview.src = URL.createObjectURL(file);
      preview.style.display = "block";
      var texts = zone.querySelectorAll(".drop-icon, .drop-title, .drop-hint");
      for (var i = 0; i < texts.length; i++) texts[i].style.display = "none";
      console.log("[Corner IA] Preview shown for:", file.name);
    } catch(err) {
      console.error("[Corner IA] Preview error:", err);
    }
  }

  /* --- Create Model toggle --- */
  var toggleCreateBtn = document.getElementById("toggleCreateModelBtn");
  var createPanel = document.getElementById("createModelPanel");
  var cancelCreateBtn = document.getElementById("cancelCreateBtn");
  if (toggleCreateBtn && createPanel) {
    toggleCreateBtn.addEventListener("click", function() {
      createPanel.classList.toggle("active");
      toggleCreateBtn.style.display = createPanel.classList.contains("active") ? "none" : "";
    });
  }
  if (cancelCreateBtn && createPanel) {
    cancelCreateBtn.addEventListener("click", function() {
      createPanel.classList.remove("active");
      if (toggleCreateBtn) toggleCreateBtn.style.display = "";
    });
  }

  /* --- Create Model form --- */
  var createForm = document.getElementById("createModelForm");
  var createBtn = document.getElementById("createModelBtn");
  if (createForm && createBtn) {
    createForm.addEventListener("submit", function(e) {
      e.preventDefault();
      hideMessages();
      var formData = new FormData(createForm);
      createBtn.disabled = true;
      createBtn.textContent = "Gerando...";
      if (loading) loading.classList.add("active");
      if (loadingText) loadingText.textContent = "Gerando sua modelo IA... pode levar at\u00e9 60 segundos.";
      console.log("[Corner IA] Creating model...");

      fetch(API_URL, { method: "POST", body: formData })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          console.log("[Corner IA] Create model response:", JSON.stringify(res.data));
          if (!res.ok || res.data.error) { showError(res.data.error || "Erro ao gerar modelo."); return; }
          showStatus("Modelo criada com sucesso! Recarregando...");
          setTimeout(function() { location.reload(); }, 1500);
        })
        .catch(function(err) { console.error("[Corner IA] Create model error:", err); showError("Erro de conex\u00e3o. Tente novamente."); })
        .finally(function() { createBtn.disabled = false; createBtn.textContent = "\u2728 Gerar modelo"; if (loading) loading.classList.remove("active"); });
    });
  }

  /* --- Select Model --- */
  function selectModel(modelId) {
    console.log("[Corner IA] Selecting model:", modelId);
    hideMessages();
    var fd = new FormData();
    fd.append("customerId", CID);
    fd.append("sessionToken", TOKEN);
    fd.append("action", "selectModel");
    fd.append("modelId", modelId);

    fetch(API_URL, { method: "POST", body: fd })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
      .then(function(res) {
        console.log("[Corner IA] Select response:", JSON.stringify(res.data));
        if (!res.ok || res.data.error) { showError(res.data.error || "Erro ao selecionar modelo."); return; }
        showStatus("Modelo selecionada! Recarregando...");
        setTimeout(function() { location.reload(); }, 800);
      })
      .catch(function(err) { console.error("[Corner IA] Select error:", err); showError("Erro de conex\u00e3o."); });
  }

  /* --- Delete Model --- */
  function deleteModel(modelId) {
    if (!confirm("Excluir esta modelo?")) return;
    console.log("[Corner IA] Deleting model:", modelId);
    hideMessages();
    var fd = new FormData();
    fd.append("customerId", CID);
    fd.append("sessionToken", TOKEN);
    fd.append("action", "deleteModel");
    fd.append("modelId", modelId);

    fetch(API_URL, { method: "POST", body: fd })
      .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
      .then(function(res) {
        console.log("[Corner IA] Delete response:", JSON.stringify(res.data));
        if (!res.ok || res.data.error) { showError(res.data.error || "Erro ao excluir modelo."); return; }
        location.reload();
      })
      .catch(function(err) { console.error("[Corner IA] Delete error:", err); showError("Erro de conex\u00e3o."); });
  }

  /* --- Bind model card buttons (event delegation) --- */
  document.addEventListener("click", function(e) {
    var selBtn = e.target.closest && e.target.closest(".mc-select");
    if (selBtn) {
      e.preventDefault();
      e.stopPropagation();
      selectModel(selBtn.getAttribute("data-id"));
      return;
    }
    var delBtn = e.target.closest && e.target.closest(".mc-delete");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      deleteModel(delBtn.getAttribute("data-id"));
      return;
    }
  });

  /* --- Generate form --- */
  var genForm = document.getElementById("generateForm");
  var submitBtn = document.getElementById("submitBtn");
  if (genForm && submitBtn) {
    genForm.addEventListener("submit", function(e) {
      e.preventDefault();
      hideMessages();
      var formData = new FormData(genForm);
      var garment = formData.get("garment");
      if (!garment || !garment.size) { showError("Envie a imagem da roupa."); return; }
      if (garment.size > 12 * 1024 * 1024) { showError("Arquivo muito grande. M\u00e1ximo 12MB."); return; }

      submitBtn.disabled = true;
      submitBtn.textContent = "Gerando...";
      if (loading) loading.classList.add("active");
      if (loadingText) loadingText.textContent = "Gerando imagem com IA... pode levar at\u00e9 60 segundos.";
      if (latestResult) latestResult.style.display = "none";
      console.log("[Corner IA] Generating image, pose:", formData.get("pose"));

      fetch(API_URL, { method: "POST", body: formData })
        .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          var data = res.data;
          console.log("[Corner IA] Generate result:", data && data.imageUrl ? "image received" : "no image");
          if (!res.ok || data.error) {
            showError(data.error || "Erro ao gerar imagem.");
            if (typeof data.credits === "number") updateCredits(data.credits);
            return;
          }
          showStatus("Imagem gerada com sucesso!");
          updateCredits(data.credits);
          if (latestImg) latestImg.src = data.imageUrl;
          if (latestDl) latestDl.href = data.imageUrl;
          if (latestResult) latestResult.style.display = "block";
          if (galleryGrid) {
            var empty = galleryGrid.querySelector(".empty-state");
            if (empty) empty.remove();
            var item = document.createElement("div"); item.className = "gallery-item";
            var img = document.createElement("img"); img.src = data.imageUrl; img.alt = "Gerada"; img.loading = "lazy";
            var meta = document.createElement("div"); meta.className = "gallery-meta";
            var dt = document.createElement("span"); dt.className = "gallery-date"; dt.textContent = data.date || "Agora";
            var dl = document.createElement("a"); dl.className = "gallery-dl"; dl.href = data.imageUrl; dl.download = ""; dl.textContent = "\u2B07";
            meta.appendChild(dt); meta.appendChild(dl);
            item.appendChild(img); item.appendChild(meta);
            galleryGrid.insertBefore(item, galleryGrid.firstChild);
          }
          /* Reset garment input */
          if (fileInput) fileInput.value = "";
          if (preview) { preview.style.display = "none"; preview.src = ""; }
          if (zone) { var t = zone.querySelectorAll(".drop-icon, .drop-title, .drop-hint"); for (var i=0;i<t.length;i++) t[i].style.display = ""; }
        })
        .catch(function(err) { console.error("[Corner IA] Generate error:", err); showError("Erro de conex\u00e3o. Tente novamente."); })
        .finally(function() { submitBtn.disabled = false; submitBtn.textContent = "\u2728 Gerar prova virtual (1 cr\u00e9dito)"; if (loading) loading.classList.remove("active"); });
    });
  }

  console.log("[Corner IA] JS init complete");
}

/* Boot: wait for DOM if needed */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", cornerIaInit);
} else {
  cornerIaInit();
}