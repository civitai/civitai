const GENERATION_FORM_KEY = 'generation-form';
export const imageGenerationFormStorage = {
  set: (data: unknown) => localStorage.setItem(GENERATION_FORM_KEY, JSON.stringify(data)),
  get: () => {
    const localValue = localStorage.getItem(GENERATION_FORM_KEY);
    return localValue ? JSON.parse(localValue) : undefined;
  },
};
