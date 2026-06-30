{
  description = "Civitai development shell (NixOS)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };

      # Prisma engines must match the npm @prisma/client version EXACTLY (engine
      # commit is embedded in the client and verified at runtime). The project
      # pins @prisma/client 6.13.0, but nixpkgs never packaged 6.13.0
      # (prisma-engines jumps 6.7 -> 6.18), so we fetch Prisma's official
      # prebuilt 6.13.0 engines and patchelf them onto NixOS instead of building
      # from source or drifting the repo's pinned client version.
      #
      # Commit comes from node_modules/@prisma/engines-version
      # (6.13.0-35.<commit>). Bump both together if @prisma/client changes.
      engineCommit = "361e86d0ea4987e9f53a565309b3eed797a6bcbd";
      enginePlatform = "debian-openssl-3.0.x"; # links libssl/libcrypto .so.3, satisfied by pkgs.openssl
      fetchEngine = file: sha256: pkgs.fetchurl {
        url = "https://binaries.prisma.sh/all_commits/${engineCommit}/${enginePlatform}/${file}.gz";
        inherit sha256;
      };

      prisma-engines = pkgs.stdenvNoCC.mkDerivation {
        pname = "prisma-engines";
        version = "6.13.0";
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.autoPatchelfHook pkgs.gzip ];
        buildInputs = [ pkgs.openssl pkgs.stdenv.cc.cc.lib pkgs.zlib ];
        dontStrip = true;

        queryLib = fetchEngine "libquery_engine.so.node" "0gamcinpfb8gvli48z16a378ziyinsanniddgbmd93v1lisllcz2";
        schemaEngine = fetchEngine "schema-engine" "0rjwada7j2gdqx5xwbxqdvhr2c8jk2mjzhyblfbryiazyv3i9ir9";
        queryEngine = fetchEngine "query-engine" "0iiknxyygq62g1n64h7nfpbfkmq5pi6d8i8di5hyv09hsmzbaimd";

        buildPhase = ''
          mkdir -p $out/lib $out/bin
          gzip -dc $queryLib    > $out/lib/libquery_engine.node
          gzip -dc $schemaEngine > $out/bin/schema-engine
          gzip -dc $queryEngine  > $out/bin/query-engine
          chmod +x $out/bin/schema-engine $out/bin/query-engine
        '';
      };
    in {
      packages.${system}.prisma-engines = prisma-engines;

      devShells.${system}.default = pkgs.mkShell {
        buildInputs = with pkgs; [
          nodejs_20
          pnpm
          openssl
          clickhouse
          postgresql_16
          redis
        ];
        env = {
          PRISMA_QUERY_ENGINE_LIBRARY = "${prisma-engines}/lib/libquery_engine.node";
          PRISMA_QUERY_ENGINE_BINARY = "${prisma-engines}/bin/query-engine";
          PRISMA_SCHEMA_ENGINE_BINARY = "${prisma-engines}/bin/schema-engine";
        };
      };
    };
}
