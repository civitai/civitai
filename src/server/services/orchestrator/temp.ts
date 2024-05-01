const regex =
  /^(?:urn:)?(?:air:)?(?:(?<ecosystem>[a-zA-Z0-9_\-\/]+):)?(?:(?<type>[a-zA-Z0-9_\-\/]+):)?(?<source>[a-zA-Z0-9_\-\/]+):(?<id>[a-zA-Z0-9_\-\/]+)(?:@(?<version>[a-zA-Z0-9_\-]+))?(?:\.(?<format>[a-zA-Z0-9_\-]+))?$/i;

type AirProps = {
  /** Type of the ecosystem (sd1, sd2, sdxl) */
  ecosystem: string;
  /** Type of the resource (model, lora, embedding, hypernet) */
  type: string;
  /**  Supported network source */
  source: string;
  /** Id of the resource from the source */
  id: string;
  version?: string;
  /** The format of the model (safetensor, ckpt, diffuser, tensor rt) optional */
  format?: string;
};

/** https://github.com/civitai/civitai/wiki/AIR-%E2%80%90-Uniform-Resource-Names-for-AI */
export abstract class Air {
  static parse(identifier: string) {
    const match = regex.exec(identifier);
    if (!match) {
      throw new Error(`Invalid identifier: ${identifier}`);
    }
    return match.groups! as AirProps;
  }
  static stringify({ ecosystem, type, source, id, version, format }: AirProps) {
    return `urn:air:${ecosystem}:${type}:${source}:${id}${version ? `@${version}` : ''}${
      format ? `:${format}` : ''
    }`;
  }
}
