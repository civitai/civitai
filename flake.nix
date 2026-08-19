{
  description = "Civitai local development environment (NixOS, x86_64-linux)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      inherit (pkgs) lib;

      # =====================================================================
      # Toolchain
      #
      # Nothing here hardcodes a version the repo already declares elsewhere.
      # `.nvmrc` and `package.json` are read directly, so the flake cannot
      # silently drift from what CI installs and what production runs. The
      # residual drift a derivation cannot prevent -- nixpkgs moving the patch
      # version under us -- is caught by `checks.toolchain-pins` below, so it
      # surfaces as a red `nix flake check` rather than as a mystery at runtime.
      #
      # Authorities, for the record:
      #   node    .nvmrc        (every GitHub workflow: node-version-file: .nvmrc)
      #                         (Dockerfile FROM node:<same>)
      #   pnpm    package.json  packageManager field
      #   prisma  pnpm-lock.yaml resolved @prisma/client (see prisma-engines)
      # =====================================================================

      nodeVersion = lib.trim (builtins.readFile ./.nvmrc);
      nodeMajor = lib.head (lib.splitString "." nodeVersion);
      nodejs = pkgs."nodejs_${nodeMajor}";

      packageJson = builtins.fromJSON (builtins.readFile ./package.json);

      # "pnpm@10.28.1" -> "10". nixpkgs will not carry every patch release and
      # does not need to: the lockfile format is tied to the major. Pinning the
      # major attribute (rather than the unversioned `pkgs.pnpm`) is what stops
      # a `nix flake update` silently handing everyone pnpm 11 -- which is
      # exactly what the unversioned attribute did between this flake's old lock
      # and its new one.
      pnpmMajor = lib.head (lib.splitString "."
        (lib.last (lib.splitString "@" packageJson.packageManager)));
      # `nodejs-slim`, not `nodejs`: pnpm's own launcher only needs a runtime,
      # and nixpkgs warns if you override the full package here. This keeps
      # pnpm's shebang node on the same major as the shell's node.
      pnpm = pkgs."pnpm_${pnpmMajor}".override {
        nodejs-slim = pkgs."nodejs-slim_${nodeMajor}";
      };

      # =====================================================================
      # Prisma engines
      #
      # `@prisma/client` embeds an engine commit and verifies it against the
      # engine binary at runtime, so the engines must match the client EXACTLY.
      # nixpkgs never packaged 6.13.0 (prisma-engines jumps 6.7 -> 6.18), so we
      # fetch Prisma's official prebuilt engines for one commit and patchelf
      # them onto NixOS rather than building from source or drifting the repo's
      # pinned client.
      #
      # Both values below are duplicates of information that lives in
      # pnpm-lock.yaml, which Nix cannot parse. `checks.prisma-pin` re-derives
      # them from the lockfile and fails if they have diverged -- package.json
      # declares `@prisma/client: ^6.3.0`, a caret range, so a routine lockfile
      # refresh is all it takes.
      #
      # To bump: change prismaVersion + engineCommit (from the lockfile's
      # `@prisma/engines-version@<version>-<n>.<commit>`), set the three sha256s
      # to lib.fakeSha256, build once, and paste in what nix reports.
      # =====================================================================

      prismaVersion = "6.13.0";
      engineCommit = "361e86d0ea4987e9f53a565309b3eed797a6bcbd";
      enginePlatform = "debian-openssl-3.0.x"; # links libssl/libcrypto .so.3, satisfied by pkgs.openssl

      fetchEngine = file: sha256: pkgs.fetchurl {
        url = "https://binaries.prisma.sh/all_commits/${engineCommit}/${enginePlatform}/${file}.gz";
        inherit sha256;
      };

      prisma-engines = pkgs.stdenvNoCC.mkDerivation {
        pname = "prisma-engines";
        version = prismaVersion;
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.gzip ];
        buildInputs = [ pkgs.openssl pkgs.stdenv.cc.cc.lib pkgs.zlib ];
        dontStrip = true;

        queryLib = fetchEngine "libquery_engine.so.node" "0gamcinpfb8gvli48z16a378ziyinsanniddgbmd93v1lisllcz2";
        schemaEngine = fetchEngine "schema-engine" "0rjwada7j2gdqx5xwbxqdvhr2c8jk2mjzhyblfbryiazyv3i9ir9";
        queryEngine = fetchEngine "query-engine" "0iiknxyygq62g1n64h7nfpbfkmq5pi6d8i8di5hyv09hsmzbaimd";

        buildPhase = ''
          mkdir -p $out/lib $out/bin
          gzip -dc $queryLib     > $out/lib/libquery_engine.node
          gzip -dc $schemaEngine > $out/bin/schema-engine
          gzip -dc $queryEngine  > $out/bin/query-engine
          chmod +x $out/bin/schema-engine $out/bin/query-engine
        '';
      };

      prismaEnv = {
        PRISMA_QUERY_ENGINE_LIBRARY = "${prisma-engines}/lib/libquery_engine.node";
        PRISMA_QUERY_ENGINE_BINARY = "${prisma-engines}/bin/query-engine";
        PRISMA_SCHEMA_ENGINE_BINARY = "${prisma-engines}/bin/schema-engine";
      };

      # =====================================================================
      # Service stack
      #
      # The SERVERS are docker-compose's job (docker-compose.base.yml), not
      # nix's -- postgres x4, redis x2, minio, meilisearch, clickhouse, maildev.
      # What the shell provides is the matching CLIENTS, because you talk to
      # those containers by hand constantly:
      #
      #   psql              -> the `db` container (postgres 17) on :15432
      #   redis-cli         -> the `redis` container on :6379
      #   clickhouse client -> the `clickhouse` container on :18123
      #
      # postgresql_17 (not _16) because the primary `db` container is
      # postgres:17 and a client older than its server is the one direction
      # libpq does not promise to work.
      # =====================================================================

      serviceClients = [
        pkgs.postgresql_17
        pkgs.redis
        pkgs.clickhouse
      ];

      # =====================================================================
      # Checks
      #
      # Deterministic, sandboxed, no network. Two python helpers live in
      # scripts/nix/ rather than inline here so they can be read, and run,
      # without going through nix (`nix run .#doctor` does exactly that).
      # =====================================================================

      checkPython = pkgs.python3.withPackages (ps: with ps; [ pyyaml node-semver ]);

      nodeCheckArgs = lib.escapeShellArgs [
        "--nvmrc" "${./.nvmrc}"
        "--package-json" "${./package.json}"
        "--flake-node" nodejs.version
        "--flake-pnpm" pnpm.version
      ];

      prismaCheckArgs = lib.escapeShellArgs [
        "--package-json" "${./package.json}"
        "--lockfile" "${./pnpm-lock.yaml}"
        "--flake-prisma-version" prismaVersion
        "--flake-engine-commit" engineCommit
      ];

      # =====================================================================
      # Entrypoints
      # =====================================================================

      dev = pkgs.writeShellApplication {
        name = "dev";
        # Docker is deliberately absent: the CLI has to match the daemon the
        # developer is already running, so it comes from the host PATH.
        runtimeInputs = [ nodejs pnpm pkgs.git pkgs.postgresql_17 pkgs.coreutils ];
        text = builtins.readFile ./scripts/nix/dev-up.sh;
        meta.description = "Bootstrap and run the civitai local dev environment";
      };

      dev-server = pkgs.writeShellApplication {
        name = "dev-server";
        runtimeInputs = [ nodejs pnpm pkgs.git ];
        text = ''
          # The dev-server daemon re-execs itself with process.execPath, so
          # whatever node launches the CLI is the node the daemon runs on
          # forever. Launching it through this wrapper is what pins it to the
          # flake's node instead of whatever happened to be on PATH.
          ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
          if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
            echo "dev-server: not inside a git checkout." >&2
            exit 1
          fi
          cd "$ROOT"
          exec node .claude/skills/dev-server/cli.mjs "$@"
        '';
        meta.description = "Run the dev-server CLI on the flake's node";
      };

      doctor = pkgs.writeShellApplication {
        name = "doctor";
        runtimeInputs = [ checkPython pkgs.git ];
        text = ''
          # Same assertions `nix flake check` makes, but against your working
          # tree rather than the committed source, so you can see the effect of
          # an edit before committing it.
          ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
          if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
            echo "doctor: not inside a git checkout." >&2
            exit 1
          fi
          cd "$ROOT"
          rc=0
          python3 scripts/nix/check-node-pin.py \
            --nvmrc .nvmrc --package-json package.json \
            --flake-node ${nodejs.version} --flake-pnpm ${pnpm.version} || rc=1
          echo
          python3 scripts/nix/check-prisma-pin.py \
            --package-json package.json --lockfile pnpm-lock.yaml \
            --flake-prisma-version ${prismaVersion} \
            --flake-engine-commit ${engineCommit} || rc=1
          exit "$rc"
        '';
        meta.description = "Check the flake's pins against the working tree";
      };
    in
    {
      packages.${system} = {
        inherit prisma-engines dev dev-server doctor;
        default = dev;
      };

      apps.${system} = {
        dev = { type = "app"; program = lib.getExe dev; meta = dev.meta; };
        dev-server = { type = "app"; program = lib.getExe dev-server; meta = dev-server.meta; };
        doctor = { type = "app"; program = lib.getExe doctor; meta = doctor.meta; };
        default = { type = "app"; program = lib.getExe dev; meta = dev.meta; };
      };

      # `nix flake check` BUILDS checks.* but only EVALUATES packages.* and
      # devShells.* -- measured, not assumed. So the three writeShellApplications
      # are re-exposed as a check below; without that, their build-time
      # shellcheck would never run under `nix flake check`.
      checks.${system} = {
        # writeShellApplication runs shellcheck + `bash -n` at build time, so
        # building these IS the lint.
        dev-scripts = pkgs.symlinkJoin {
          name = "check-dev-scripts";
          paths = [ dev dev-server doctor ];
        };

        toolchain-pins = pkgs.runCommand "check-toolchain-pins"
          { nativeBuildInputs = [ checkPython ]; }
          ''
            python3 ${./scripts/nix/check-node-pin.py} ${nodeCheckArgs}
            touch $out
          '';

        prisma-pin = pkgs.runCommand "check-prisma-pin"
          { nativeBuildInputs = [ checkPython ]; }
          ''
            python3 ${./scripts/nix/check-prisma-pin.py} ${prismaCheckArgs}
            touch $out
          '';

        # The two guards above only assert that today's pins agree. This one
        # asserts the guards can still SEE a disagreement: it breaks each pin on
        # purpose and requires the specific guard that owns it to fire, and the
        # others to stay silent. Without it, either guard could rot into a
        # constant `true` and every check would stay green.
        pin-guards-selftest = pkgs.runCommand "check-pin-guards-selftest"
          {
            nativeBuildInputs = [ checkPython pkgs.bash pkgs.gnused pkgs.gnugrep ];
            NODE_SCRIPT = "${./scripts/nix/check-node-pin.py}";
            PRISMA_SCRIPT = "${./scripts/nix/check-prisma-pin.py}";
            NVMRC = "${./.nvmrc}";
            PACKAGE_JSON = "${./package.json}";
            LOCKFILE = "${./pnpm-lock.yaml}";
          }
          ''
            bash ${./scripts/nix/test-pins.sh}
            touch $out
          '';
      };

      devShells.${system}.default = pkgs.mkShell {
        buildInputs = [ nodejs pnpm pkgs.openssl ] ++ serviceClients;

        # `env` is baked into the cached shell profile, so direnv reloads pay
        # nothing for it. Keep anything expensive out of shellHook: nix-direnv
        # re-runs the hook on every reload even when the shell itself is cached.
        env = prismaEnv // {
          # pnpm 10 will otherwise download and exec the exact version named in
          # package.json's packageManager field, quietly replacing the pnpm this
          # flake just pinned. Turning it off is what makes the flake's pnpm the
          # one that actually runs.
          npm_config_manage_package_manager_versions = "false";
        };

        shellHook = ''
          echo "civitai dev shell: node $(node --version), pnpm $(pnpm --version)"
          echo "  nix run .#dev     bootstrap services + run the app"
          echo "  nix run .#doctor  check toolchain pins"
        '';
      };
    };
}
