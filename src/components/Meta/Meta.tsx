import Head from 'next/head';

export function Meta({ title, description, image, links = [], schema, deIndex }: Props) {
  return (
    <Head>
      <title>{title}</title>
      <meta name="title" content={title} />
      <meta name="description" content={description} />

      <meta property="og:type" content="website" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={image} />

      <meta property="twitter:card" content="summary_large_image" />
      <meta property="twitter:title" content={title} />
      <meta property="twitter:description" content={description} />
      <meta property="twitter:image" content={image} />
      {image && <meta name="robots" content="max-image-preview:large" />}
      {deIndex && <meta name="robots" content={deIndex} />}

      {links.map((link, index) => (
        <link key={link.href || index} {...link} />
      ))}
      {schema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
          key="product-schema"
        ></script>
      )}
    </Head>
  );
}

type Props = {
  title: string;
  description?: string;
  image?: string;
  links?: React.LinkHTMLAttributes<HTMLLinkElement>[];
  schema?: object;
  deIndex?: string;
};
