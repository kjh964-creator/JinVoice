import { useTranslation } from 'react-i18next';
import { EasyFeatureSettings } from './easy-feature-settings';
import { EasyPage } from './easy-layout';

/**
 * The feature switches as an easy screen (large text, phone friendly), opened
 * from the easy home. Settings → General shows the same list.
 */
export function EasyFeaturesPage() {
  const { t } = useTranslation();
  return (
    <EasyPage title={t('easy.features_title')}>
      <EasyFeatureSettings variant="page" />
    </EasyPage>
  );
}
