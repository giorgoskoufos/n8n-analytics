# Third-party licences

Everything in this directory is vendored — committed to the repository and
served to the browser directly, because this project has no bundler and pulls
nothing from a CDN at runtime.

Several of these are minified, and minification strips comment headers. Those
licences still require their copyright notices to be reproduced with the
redistributed files, so the notices are collected here. This file is that
reproduction; do not delete it.

Regenerate the assets with `node src/scripts/vendorAssets.js`. Versions are
pinned in [`package.json`](../../package.json), and CI fails if what is
committed here has drifted from the lockfile.

---

## Chart.js

- **Licence:** MIT
- **Copyright:** © 2014–2024 Chart.js Contributors
- **Home:** https://www.chartjs.org
- Files: `chart.umd.min.js`
- The header is preserved in the file itself.

## DOMPurify

- **Licence:** Apache-2.0 OR MPL-2.0 (dual)
- **Copyright:** © Dr.-Ing. Mario Heiderich, Cure53
- **Home:** https://github.com/cure53/DOMPurify
- Files: `purify.min.js`
- The header is preserved in the file itself.

## marked

- **Licence:** MIT
- **Copyright:** © 2011–2018 Christopher Jeffrey and contributors
- **Home:** https://marked.js.org
- Files: `marked.umd.js`
- The header is preserved in the file itself.

## highlight.js

- **Licence:** BSD-3-Clause
- **Copyright:** © 2006 Ivan Sagalaev. All rights reserved.
- **Home:** https://highlightjs.org
- Files: `highlight.js`

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice,
>    this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
> 3. Neither the name of the copyright holder nor the names of its contributors
>    may be used to endorse or promote products derived from this software
>    without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

## Font Awesome Free

- **Licences:** icons CC BY 4.0, fonts SIL OFL 1.1, code MIT
- **Copyright:** © Fonticons, Inc.
- **Home:** https://fontawesome.com
- Files: `fontawesome/css/`, `fontawesome/webfonts/`
- The header is preserved in `all.min.css`.

CC BY 4.0 requires attribution for the icons. This entry is that attribution.

## Open Sans

- **Licence:** SIL Open Font License 1.1
- **Copyright:** © 2020 The Open Sans Project Authors
  (https://github.com/googlefonts/opensans)
- **Home:** https://fonts.google.com/specimen/Open+Sans
- Files: `open-sans/open-sans.css`, `open-sans/files/`

> This Font Software is licensed under the SIL Open Font License, Version 1.1.
> The full licence is available at https://scripts.sil.org/OFL
>
> The Font Software may be sold as part of a larger software package but it may
> not be sold on its own. Neither the Font Software nor any of its individual
> components may be modified and distributed under a Reserved Font Name without
> permission.
