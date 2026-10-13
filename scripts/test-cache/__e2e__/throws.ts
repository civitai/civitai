import { weight } from './heavy-dep';

throw new Error(`throws.ts never finishes loading (${weight})`);
