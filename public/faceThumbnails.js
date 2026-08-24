(function initFaceThumbnails() {
    const gallery = document.getElementById("face-thumbnail-gallery");
    const status = document.getElementById("face-thumbnail-status");
    const refreshButton = document.getElementById("face-thumbnail-refresh");
    const video = document.getElementById("face-clip") ||
        document.getElementById("playback");

    if (!gallery || !status || !video) {
        return;
    }

    let player = null;

    function setStatus(html) {
        status.innerHTML = html;
    }

    function stopClip() {
        if (player) {
            try {
                player.pause();
                player.unload();
                player.detachMediaElement();
                player.destroy();
            }
            catch (_error) {
                // ignore
            }

            player = null;
        }

        video.removeAttribute("src");
        video.load();
    }

    function playClip(item) {
        if (typeof mpegts === "undefined" || !mpegts.isSupported()) {
            setStatus(
                '<span class="error">This browser cannot play MPEG-TS playback</span>'
            );
            return;
        }

        stopClip();

        const params = new URLSearchParams({
            start: item.start,
            end: item.end
        });
        const url = `/api/recordings/stream?${params.toString()}`;

        player = mpegts.createPlayer({
            type: "mpegts",
            isLive: true,
            url
        });

        player.on(
            mpegts.Events.ERROR,
            (errorType, errorDetail) => {
                setStatus(
                    `<span class="error">Playback error: ${errorDetail || errorType}</span>`
                );
            }
        );

        player.attachMediaElement(video);
        player.load();
        Promise.resolve(player.play()).catch(() => {});

        const when = new Date(item.timeIso).toLocaleString();

        setStatus(
            `<span class="ok">Playing ${item.group} at ${when}</span> ` +
            `<span class="muted">(${item.padSeconds}s before → ${item.padSeconds}s after)</span>`
        );
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/"/g, "&quot;");
    }

    function render(files) {
        if (!files.length) {
            gallery.innerHTML = '<p class="muted">No face thumbnails yet. Run fetchFaces.js first.</p>';
            return;
        }

        gallery.innerHTML = files.map((item) => {
            const when = new Date(item.timeIso).toLocaleString();
            const label = escapeHtml(`${item.group} ${when}`);

            return (
                `<button type="button" class="face-thumb" data-file="${escapeHtml(item.file)}">` +
                `<img src="${escapeHtml(item.url)}?t=${item.mtimeMs}" alt="${label}">` +
                `<span class="face-thumb-caption">${escapeHtml(item.group)}<br>${escapeHtml(when)}</span>` +
                `</button>`
            );
        }).join("");

        gallery.querySelectorAll(".face-thumb").forEach((button, index) => {
            button.addEventListener("click", (event) => {
                event.preventDefault();
                gallery.querySelectorAll(".face-thumb").forEach((el) => {
                    el.classList.remove("selected");
                });
                button.classList.add("selected");
                playClip(files[index]);
            });
        });
    }

    async function loadThumbnails() {
        setStatus("Loading face thumbnails...");

        const response = await fetch("/api/face-thumbnails");
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Failed to load face thumbnails");
        }

        setStatus(
            `${data.count || 0} thumbnail(s). Click one to play 5s before and after from the SD card.`
        );
        render(data.files || []);
        return data;
    }

    if (refreshButton) {
        refreshButton.addEventListener("click", () => {
            loadThumbnails().catch((error) => {
                setStatus(`<span class="error">${error.message}</span>`);
            });
        });
    }

    loadThumbnails().catch((error) => {
        setStatus(`<span class="error">${error.message}</span>`);
    });
})();
